include("scripts/EAction.js");
include("scripts/simple.js");

// 1. 定义工具类
function GlobalAutoTrace(guiAction) {
    EAction.call(this, guiAction);
}

// 2. 继承自 EAction
GlobalAutoTrace.prototype = new EAction();

// 3. 核心逻辑
GlobalAutoTrace.prototype.beginEvent = function() {
    EAction.prototype.beginEvent.call(this);

    var doc = this.getDocument();
    var di = this.getDocumentInterface();

    if (isNull(doc) || isNull(di)) {
        this.terminate();
        return;
    }

    var tolerance = 1e-4; 
    var gridSize = 0.01; 
    
    // 智能获取范围：如果有选中的图元，就在选中范围内操作；如果没有，就扫描全图
    var candidateIds = doc.querySelectedEntities();
    var isSelectionMode = true;
    if (candidateIds.length === 0) {
        candidateIds = doc.queryAllEntities();
        isSelectionMode = false;
    }

    var grid = {};
    var allValidItems = []; 

    // 第一步：极速收集并构建全局空间网格
    for (var i = 0; i < candidateIds.length; i++) {
        var id = candidateIds[i];
        var ent = doc.queryEntity(id);
        
        var layer = doc.queryLayer(ent.getLayerId());
        if (!isNull(layer) && layer.isLocked()) continue;

        var eType = ent.getType();
        if (eType === RS.EntityLine || eType === RS.EntityArc) {
            var shape = ent.castToShape().clone();
            
            var item = { 
                id: id, 
                shape: shape, 
                used: false,
                layerId: ent.getLayerId(),
                linetypeId: ent.getLinetypeId(),
                lineweight: ent.getLineweight(),
                color: ent.getColor() // 获取底层 QColor 封装对象
            };
            allValidItems.push(item);

            var cSt = shape.getStartPoint();
            var keySt = Math.floor(cSt.x / gridSize) + "_" + Math.floor(cSt.y / gridSize);
            if (!grid[keySt]) grid[keySt] = [];
            grid[keySt].push(item);

            var cEnd = shape.getEndPoint();
            var keyEnd = Math.floor(cEnd.x / gridSize) + "_" + Math.floor(cEnd.y / gridSize);
            if (keyEnd !== keySt) {
                if (!grid[keyEnd]) grid[keyEnd] = [];
                grid[keyEnd].push(item);
            }
        }
    }

    if (allValidItems.length === 0) {
        EAction.handleUserMessage("未找到可处理的线段或圆弧。");
        this.terminate();
        return;
    }

    // --- 修改点1：传入 seedItem，强制执行严格的“属性匹配” ---
    function findAdjacent(pt, seedItem) {
        var cx = Math.floor(pt.x / gridSize);
        var cy = Math.floor(pt.y / gridSize);
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                var key = (cx + dx) + "_" + (cy + dy);
                var cell = grid[key];
                if (cell) {
                    for (var j = 0; j < cell.length; j++) {
                        var cand = cell[j];
                        if (cand.used) continue; 

                        // 只有图层、颜色和线型完全一致的线段才允许合并。
                        // 防止例如红线吃掉相连的蓝线，导致蓝线属性丢失。
                        if (cand.layerId !== seedItem.layerId || 
                            cand.color.name() !== seedItem.color.name() || 
                            cand.linetypeId !== seedItem.linetypeId) {
                            continue;
                        }

                        var dSt = cand.shape.getStartPoint().getDistanceTo(pt);
                        var dEnd = cand.shape.getEndPoint().getDistanceTo(pt);

                        if (dSt <= tolerance || dEnd <= tolerance) {
                            cand.used = true; 
                            return cand;
                        }
                    }
                }
            }
        }
        return null;
    }

    var op = new RAddObjectsOperation();
    op.setText("Global Auto Trace (全图自动合并)");
    
    var totalMergedGroups = 0;
    var totalLinesConsumed = 0;

    // 第二步：遍历所有线条，将没被用过的线条作为“种子”去生长
    for (var i = 0; i < allValidItems.length; i++) {
        var seedItem = allValidItems[i];
        
        if (seedItem.used) continue; 
        
        seedItem.used = true; 
        
        var polyline = new RPolyline();
        polyline.appendShape(seedItem.shape.clone());
        var originalIds = [seedItem.id];
        var changed = true;

        // 向两端生长
        while (changed) {
            changed = false;
            var startPt = polyline.getStartPoint();
            var endPt = polyline.getEndPoint();

            // 尝试拼尾部 (将 seedItem 作为匹配标准传入)
            var adjEnd = findAdjacent(endPt, seedItem);
            if (adjEnd !== null) {
                if (adjEnd.shape.getStartPoint().getDistanceTo(endPt) <= tolerance) {
                    polyline.appendShape(adjEnd.shape);
                } else {
                    adjEnd.shape.reverse();
                    polyline.appendShape(adjEnd.shape);
                }
                originalIds.push(adjEnd.id);
                changed = true;
                continue;
            }

            // 尝试拼头部
            var adjStart = findAdjacent(startPt, seedItem);
            if (adjStart !== null) {
                if (adjStart.shape.getStartPoint().getDistanceTo(startPt) <= tolerance) {
                    polyline.reverse();
                    polyline.appendShape(adjStart.shape);
                } else {
                    polyline.reverse();
                    adjStart.shape.reverse();
                    polyline.appendShape(adjStart.shape);
                }
                originalIds.push(adjStart.id);
                changed = true;
                continue;
            }
            
            // 检查闭合
            if (originalIds.length > 1 && polyline.getStartPoint().getDistanceTo(polyline.getEndPoint()) <= tolerance) {
                break; 
            }
        }

        // 只有当至少拼了两根以上的线时，才生成实体
        if (originalIds.length > 1) {
            if (polyline.getStartPoint().getDistanceTo(polyline.getEndPoint()) <= tolerance && polyline.countVertices() > 2) {
                polyline.setClosed(true);
            }

            var polyData = new RPolylineData(polyline);
            var polyEntity = new RPolylineEntity(doc, polyData);

            // --- 修改点2：弃用零散赋值，改用原生的 copyAttributesFrom ---
            // 直接重新获取种子实体的底层指针进行无损克隆，避免 QtScript 引用丢失导致的颜色被置回默认
            var originalSeedEnt = doc.queryEntity(seedItem.id);
            if (!isNull(originalSeedEnt)) {
                polyEntity.copyAttributesFrom(originalSeedEnt);
            }

            op.addObject(polyEntity);
            
            // 把被吃掉的散线删掉
            for (var k = 0; k < originalIds.length; k++) {
                var delEnt = doc.queryEntity(originalIds[k]);
                if (!isNull(delEnt)) {
                    op.deleteObject(delEnt);
                }
            }
            
            totalMergedGroups++;
            totalLinesConsumed += originalIds.length;
        }
    }

    // 第三步：应用修改
    if (totalMergedGroups > 0) {
        di.applyOperation(op);
        
        var scopeMsg = isSelectionMode ? "在选中范围内" : "在全图中";
        EAction.handleUserMessage("批处理完成！" + scopeMsg + "共将 " + totalLinesConsumed + " 段散线，按颜色/图层规则合并成了 " + totalMergedGroups + " 条多段线。");
    } else {
        EAction.handleUserMessage("未找到任何属性相同且可以互相连接的线段。");
    }

    this.terminate(); 
};

// 4. UI 注册代码
GlobalAutoTrace.init = function(basePath) {
    var action = new RGuiAction("Global Auto Trace (全图自动合并)", RMainWindowQt.getMainWindow());
    action.setRequiresDocument(true);
    action.setScriptFile(basePath + "/GlobalAutoTrace.js");
    action.setWidgetNames(["MiscModifyMenu"]);
    
    // 自定义快捷键：连按 G 和 T (Global Trace)
    action.setDefaultShortcut(new QKeySequence("G,T"));
    
    // 命令行调用的命令名
    action.setDefaultCommands(["globaltrace", "gt"]);

    action.setGroupSortOrder(0); 
    action.setSortOrder(2);      
};