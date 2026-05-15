// 【修复点 1】：引入 QCAD 标准的 EAction 交互框架
include("scripts/EAction.js");
include("scripts/simple.js");

// 1. 定义工具类
function AutoTrace(guiAction) {
    // 【修复点 2】：调用 EAction 构造函数
    EAction.call(this, guiAction);
}

// 【修复点 3】：继承自 EAction
AutoTrace.prototype = new EAction();

// 2. 核心逻辑：当动作触发时执行
AutoTrace.prototype.beginEvent = function() {
    // 【修复点 4】：必须首先调用父类的 beginEvent 来初始化事件循环
    EAction.prototype.beginEvent.call(this);

    var doc = this.getDocument();
    var di = this.getDocumentInterface();

    if (isNull(doc) || isNull(di)) {
        this.terminate(); // 结束动作
        return;
    }

    var selectedIds = doc.querySelectedEntities();
    if (selectedIds.length !== 1) {
        EAction.handleUserWarning("【自动追踪】请仅仅选中【一根】线或圆弧作为起点！");
        this.terminate();
        return;
    }

    var seedId = selectedIds[0];
    var seedEntity = doc.queryEntity(seedId);
    var type = seedEntity.getType();

    if (type !== RS.EntityLine && type !== RS.EntityArc) {
        EAction.handleUserWarning("选中的起点必须是线段(Line)或圆弧(Arc)。");
        this.terminate();
        return;
    }

    var tolerance = 1e-4; 
    var gridSize = 0.01; 
    var grid = {};

    // 纯JS极速网格算法
    var allIds = doc.queryAllEntities();
    for (var i = 0; i < allIds.length; i++) {
        var id = allIds[i];
        if (id === seedId) continue; 

        var ent = doc.queryEntity(id);
        var layer = doc.queryLayer(ent.getLayerId());
        if (!isNull(layer) && layer.isLocked()) continue;

        var eType = ent.getType();
        if (eType === RS.EntityLine || eType === RS.EntityArc) {
            var shape = ent.castToShape().clone();
            var item = { id: id, shape: shape, used: false };

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

    function findAdjacent(pt) {
        var cx = Math.floor(pt.x / gridSize);
        var cy = Math.floor(pt.y / gridSize);

        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                var key = (cx + dx) + "_" + (cy + dy);
                var cell = grid[key];
                if (cell) {
                    for (var j = 0; j < cell.length; j++) {
                        var item = cell[j];
                        if (item.used) continue;

                        var dSt = item.shape.getStartPoint().getDistanceTo(pt);
                        var dEnd = item.shape.getEndPoint().getDistanceTo(pt);

                        if (dSt <= tolerance || dEnd <= tolerance) {
                            item.used = true;
                            return item;
                        }
                    }
                }
            }
        }
        return null;
    }

    var op = new RAddObjectsOperation();
    op.setText("Auto Trace (极速追踪)");

    var polyline = new RPolyline();
    polyline.appendShape(seedEntity.castToShape().clone());
    var originalIds = [seedId];
    var changed = true;

    while (changed) {
        changed = false;
        var startPt = polyline.getStartPoint();
        var endPt = polyline.getEndPoint();

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
        
        if (originalIds.length > 1 && polyline.getStartPoint().getDistanceTo(polyline.getEndPoint()) <= tolerance) {
            break; 
        }
    }

    if (originalIds.length > 1) {
        var isClosedLoop = false;
        if (polyline.getStartPoint().getDistanceTo(polyline.getEndPoint()) <= tolerance && polyline.countVertices() > 2) {
            polyline.setClosed(true);
            isClosedLoop = true;
        }

        var polyData = new RPolylineData(polyline);
        var polyEntity = new RPolylineEntity(doc, polyData);

        polyEntity.setLayerId(seedEntity.getLayerId());
        polyEntity.setLinetypeId(seedEntity.getLinetypeId());
        polyEntity.setLineweight(seedEntity.getLineweight());
        polyEntity.setColor(seedEntity.getColor());

        op.addObject(polyEntity);
        for (var k = 0; k < originalIds.length; k++) {
            var delEnt = doc.queryEntity(originalIds[k]);
            if (!isNull(delEnt)) {
                op.deleteObject(delEnt);
            }
        }

        di.applyOperation(op);
        
        var msg = "追踪完成！瞬间合并了 " + originalIds.length + " 段线条。";
        msg += isClosedLoop ? " (已完美闭合！)" : " (开放折线)。";
        EAction.handleUserMessage(msg);

    } else {
        EAction.handleUserMessage("追踪结束：未找到相连的其他线段。");
    }

    // 执行完毕后退出工具状态
    this.terminate(); 
};

// 3. UI 注册代码
AutoTrace.init = function(basePath) {
    var action = new RGuiAction("Auto Trace and Merge (极速合并)", RMainWindowQt.getMainWindow());
    action.setRequiresDocument(true);
    action.setScriptFile(basePath + "/AutoTrace.js");
    action.setWidgetNames(["MiscModifyMenu"]);
    action.setDefaultShortcut(new QKeySequence("A,T"));
    action.setDefaultCommands(["autotrace", "at"]);

    action.setGroupSortOrder(0); // 设置组排序为0（最高优先级，强制置顶，并自动生成一条分割线）
    action.setSortOrder(1);      // 在这组里面排第 1 个
};