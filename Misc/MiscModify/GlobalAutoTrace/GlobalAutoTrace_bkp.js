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
    var allValidItems = []; // 存放所有可以作为“种子”的线条对象

    // 第一步：极速收集并构建全局空间网格
    for (var i = 0; i < candidateIds.length; i++) {
        var id = candidateIds[i];
        var ent = doc.queryEntity(id);
        
        var layer = doc.queryLayer(ent.getLayerId());
        if (!isNull(layer) && layer.isLocked()) continue;

        var eType = ent.getType();
        if (eType === RS.EntityLine || eType === RS.EntityArc) {
            var shape = ent.castToShape().clone();
            
            // 创建统一的内存对象，包含使用状态(used)
            var item = { 
                id: id, 
                shape: shape, 
                used: false,
                layerId: ent.getLayerId(),
                linetypeId: ent.getLinetypeId(),
                lineweight: ent.getLineweight(),
                color: ent.getColor()
            };
            allValidItems.push(item);

            // 将该对象的引用放入网格（起点和终点所在的格子）
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

    // --- 九宫格搜索函数 ---
    function findAdjacent(pt) {
        var cx = Math.floor(pt.x / gridSize);
        var cy = Math.floor(pt.y / gridSize);
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                var key = (cx + dx) + "_" + (cy + dy);
                var cell = grid[key];
                if (cell) {
                    for (var j = 0; j < cell.length; j++) {
                        var cand = cell[j];
                        if (cand.used) continue; // 已经被别的多段线吃掉的，跳过

                        var dSt = cand.shape.getStartPoint().getDistanceTo(pt);
                        var dEnd = cand.shape.getEndPoint().getDistanceTo(pt);

                        if (dSt <= tolerance || dEnd <= tolerance) {
                            cand.used = true; // 标记为已使用
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
        
        // 如果这根线已经在之前的循环中被拼接到别的地方去了，直接跳过
        if (seedItem.used) continue; 
        
        seedItem.used = true; // 标记自己为已使用
        
        var polyline = new RPolyline();
        polyline.appendShape(seedItem.shape.clone());
        var originalIds = [seedItem.id];
        var changed = true;

        // 向两端生长
        while (changed) {
            changed = false;
            var startPt = polyline.getStartPoint();
            var endPt = polyline.getEndPoint();

            // 尝试拼尾部
            var adjEnd = findAdjacent(endPt);
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
            var adjStart = findAdjacent(startPt);
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

            // 继承当前“种子”的属性
            polyEntity.setLayerId(seedItem.layerId);
            polyEntity.setLinetypeId(seedItem.linetypeId);
            polyEntity.setLineweight(seedItem.lineweight);
            polyEntity.setColor(seedItem.color);

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
        EAction.handleUserMessage("批处理完成！" + scopeMsg + "共将 " + totalLinesConsumed + " 段散线，合并成了 " + totalMergedGroups + " 条多段线。");
    } else {
        EAction.handleUserMessage("未找到任何可以互相连接的线段。");
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

    action.setGroupSortOrder(0); // 必须和上面一样是 0，表示它们是同一个VIP包厢的
    action.setSortOrder(2);      // 在这组里面排第 2 个
};