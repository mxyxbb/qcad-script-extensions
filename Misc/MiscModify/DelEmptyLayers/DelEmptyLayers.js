include("scripts/EAction.js");

/**
 * 构造函数
 */
function DelEmptyLayers(guiAction) {
    EAction.call(this, guiAction);
}

// 继承自 EAction
DelEmptyLayers.prototype = new EAction();

/**
 * 核心逻辑：当动作被触发时执行
 */
DelEmptyLayers.prototype.beginEvent = function() {
    var doc = this.getDocument();
    var di = this.getDocumentInterface();

    if (isNull(doc) || isNull(di)) {
        this.terminate();
        return;
    }

    // 1. 遍历所有的图块和实体，提取正在被使用的图层 ID
    var usedLayers = {};
    var blockIds = doc.queryAllBlocks();
    
    for (var b = 0; b < blockIds.length; b++) {
        var entityIds = doc.queryBlockEntities(blockIds[b]);
        for (var i = 0; i < entityIds.length; i++) {
            // 使用 Direct 获取可提高只读查询的性能
            var entity = doc.queryEntityDirect(entityIds[i]);
            if (!isNull(entity)) {
                usedLayers[entity.getLayerId()] = true;
            }
        }
    }

    // 2. 遍历所有图层并过滤出空图层
    var op = new RMixedOperation();
    var deletedCount = 0;
    var layerIds = doc.queryAllLayers();

    for (var i = 0; i < layerIds.length; i++) {
        var layerId = layerIds[i];
        
        // 如果图层已被使用，跳过
        if (usedLayers[layerId]) {
            continue;
        }

        // 使用 queryLayer 获取图层对象以用于修改/删除操作
        var layer = doc.queryLayer(layerId);
        if (isNull(layer)) {
            continue;
        }

        // 默认的 "0" 图层通常承载基础结构，即便为空也不应删除
        if (layer.getName() === "0") {
            continue;
        }

        // 将该空图层添加到删除操作中
        op.deleteObject(layer);
        deletedCount++;
    }

    // 3. 执行删除操作并提示用户结果
    if (deletedCount > 0) {
        di.applyOperation(op);
        EAction.handleUserInfo("成功删除了 " + deletedCount + " 个空图层。");
    } else {
        EAction.handleUserInfo("未发现任何可删除的空图层。");
    }

    // 结束当前动作
    this.terminate();
};

/**
 * UI 注册代码 (保持原样)
 * 注意：已将你原片段的 DelAllCircles 改成了对应的 DelEmptyLayers，确保 QCAD 可以正确初始化
 */
DelEmptyLayers.init = function(basePath) {
    var action = new RGuiAction("Delete Empty Layers (删除空图层)", RMainWindowQt.getMainWindow());
    action.setRequiresDocument(true);
    action.setScriptFile(basePath + "/DelEmptyLayers.js");
    // 注册到 杂项(Misc) -> 修改(Modify) 菜单下
    action.setWidgetNames(["MiscModifyMenu"]);
    action.setDefaultShortcut(new QKeySequence("D,E"));
    action.setDefaultCommands(["dellayers", "de"]);

    action.setGroupSortOrder(0); // 设置组排序为0（最高优先级，强制置顶，并自动生成一条分割线）
    action.setSortOrder(5);      // 在这组里面排第 5 个
};