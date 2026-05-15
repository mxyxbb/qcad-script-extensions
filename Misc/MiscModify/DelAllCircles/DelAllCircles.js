include("scripts/EAction.js");

function DelAllCircles(guiAction) {
    EAction.call(this, guiAction);
}

DelAllCircles.prototype = new EAction();

DelAllCircles.prototype.beginEvent = function() {
    EAction.prototype.beginEvent.call(this);

    // 【修正 1】：在 EAction 工具类中，必须使用 this. 来获取当前文档和接口
    var di = this.getDocumentInterface();
    var doc = this.getDocument();
    
    // 安全检查：如果没有打开的文档，则直接退出
    if (isNull(di) || isNull(doc)) {
        this.terminate();
        return;
    }

    var ids = doc.queryAllEntities();
    var count = 0;

    // 创建一个批量删除操作，避免界面卡顿
    var op = new RDeleteObjectsOperation();

    for (var i = 0; i < ids.length; i++) {
        // 获取实体对象
        var entity = doc.queryEntity(ids[i]);
        
        // 确认实体存在且为圆形
        if (!isNull(entity) && entity.getType() == RS.EntityCircle) {
            // 加入待删除队列
            op.deleteObject(entity);
            count++;
        }
    }

    // 提交删除操作
    if (count > 0) {
        di.applyOperation(op);
        // 【修正 2】：正式脚本中推荐使用 handleUserMessage 向命令行输出信息，并修正了文案
        EAction.handleUserMessage("清理完毕：成功删除了 " + count + " 个圆形！");
    } else {
        EAction.handleUserMessage("图纸中没有找到任何圆形。");
    }

    // 执行完毕后退出工具状态
    this.terminate(); 
};

// UI 注册代码 (保持原样)
DelAllCircles.init = function(basePath) {
    var action = new RGuiAction("Delete All Circles (删除圆形)", RMainWindowQt.getMainWindow());
    action.setRequiresDocument(true);
    action.setScriptFile(basePath + "/DelAllCircles.js");
    // 注册到 杂项(Misc) -> 修改(Modify) 菜单下
    action.setWidgetNames(["MiscModifyMenu"]);
    action.setDefaultShortcut(new QKeySequence("D,C"));
    action.setDefaultCommands(["delcircles", "dc"]);

    action.setGroupSortOrder(0); // 设置组排序为0（最高优先级，强制置顶，并自动生成一条分割线）
    action.setSortOrder(4);      // 在这组里面排第 4 个
};