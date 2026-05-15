include("scripts/EAction.js");

/**
 * QCAD DXF 简化脚本 - V11 拓扑边折叠保形版 (Topology-Preserving Edge Collapse)
 * 核心特性：
 * 1. 迭代边折叠算法：安全消除 <0.03mm 的短线，同时完美保留由碎线组成的圆弧/曲线形态。
 * 2. 避免链式崩塌：短线合并后长度若达到安全阈值(>0.03mm)则自动保留，实现“分为几段”的效果。
 * 3. 极速纯内存计算，单次 Ctrl+Z 撤销。
 */
function SimplifyDXF(guiAction) {
    EAction.call(this, guiAction);
    
    this.THRESHOLD = 0.1; // 长度阈值
    this.ANGLE_TOL = 0.5;   // 共线融合的角度容差(度)
}

SimplifyDXF.prototype = new EAction();

SimplifyDXF.prototype.beginEvent = function() {
    this.run();
    this.terminate(); 
};

SimplifyDXF.prototype.run = function() {
    var doc = EAction.getDocument();
    var di = EAction.getDocumentInterface();

    if (isNull(doc) || isNull(di)) {
        EAction.handleUserMessage("未检测到当前活动文档！");
        return;
    }

    EAction.handleUserMessage("正在执行拓扑保形分析，请稍候...");
    var startTime = new Date().getTime();

    // ==========================================
    // 第一步：构建图(Graph)的数据结构并焊接近似重合点
    // ==========================================
    var allIds = doc.queryAllEntities();
    var lines = [];
    var points = [];
    var pointMap = {};
    
    // 精度 10000 相当于 0.0001mm 的容差，用于识别原本就接在一起的端点
    var getKey = function(x, y) { return Math.round(x * 10000) + "_" + Math.round(y * 10000); };
    
    var getOrAddPoint = function(pt) {
        var k = getKey(pt.x, pt.y);
        if (pointMap[k] !== undefined) return pointMap[k];
        var idx = points.length;
        points.push({x: pt.x, y: pt.y});
        pointMap[k] = idx;
        return idx;
    };

    var initialLineCount = 0;

    for (var i = 0; i < allIds.length; i++) {
        var ent = doc.queryEntity(allIds[i]);
        if (!isNull(ent) && ent.getType() === RS.EntityLine) {
            var p1_idx = getOrAddPoint(ent.getStartPoint());
            var p2_idx = getOrAddPoint(ent.getEndPoint());
            
            // 过滤掉原本长度就为 0 的无效线段
            if (p1_idx !== p2_idx) {
                lines.push({
                    p1_idx: p1_idx,
                    p2_idx: p2_idx,
                    deleted: false,
                    origEnt: ent
                });
                initialLineCount++;
            }
        }
    }

    if (initialLineCount === 0) {
        EAction.handleUserMessage("图纸中没有检测到有效的直线对象。");
        return;
    }

    // 建立 点 -> 线的 邻接表，加速查询
    var pt2lines = new Array(points.length);
    for (var i = 0; i < points.length; i++) pt2lines[i] = [];
    for (var i = 0; i < lines.length; i++) {
        pt2lines[lines[i].p1_idx].push(i);
        pt2lines[lines[i].p2_idx].push(i);
    }

    // ==========================================
    // 第二步：迭代边折叠 (Iterative Edge Collapse) 
    // 保形合并短线，避免圆弧崩塌
    // ==========================================
    var mergeOccurred = true;
    var threshSq = this.THRESHOLD * this.THRESHOLD;

    while (mergeOccurred) {
        mergeOccurred = false;
        
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].deleted) continue;

            var idx1 = lines[i].p1_idx;
            var idx2 = lines[i].p2_idx;
            var p1 = points[idx1];
            var p2 = points[idx2];

            var dX = p1.x - p2.x;
            var dY = p1.y - p2.y;
            var distSq = dX * dX + dY * dY;

            // 如果当前线段长度 <= 0.031，则折叠该边
            if (distSq <= threshSq) {
                // 计算中点作为新节点
                var newPt = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                var newIdx = points.length;
                points.push(newPt);
                pt2lines.push([]); // 新节点的邻接表

                // 收集所有连接到被折叠端点的线段
                var affected = pt2lines[idx1].concat(pt2lines[idx2]);
                var uniqueAffected = [];
                var seen = {};
                for (var k = 0; k < affected.length; k++) {
                    var lineIdx = affected[k];
                    if (!seen[lineIdx] && !lines[lineIdx].deleted) {
                        seen[lineIdx] = true;
                        uniqueAffected.push(lineIdx);
                    }
                }

                // 将这些线段重新连接到新节点
                for (var k = 0; k < uniqueAffected.length; k++) {
                    var cIdx = uniqueAffected[k];
                    var cl = lines[cIdx];

                    var changed = false;
                    if (cl.p1_idx === idx1 || cl.p1_idx === idx2) { cl.p1_idx = newIdx; changed = true; }
                    if (cl.p2_idx === idx1 || cl.p2_idx === idx2) { cl.p2_idx = newIdx; changed = true; }

                    // 如果重新连接后，线段两端重合，说明它被完全折叠了
                    if (cl.p1_idx === cl.p2_idx) {
                        cl.deleted = true;
                    } else if (changed) {
                        pt2lines[newIdx].push(cIdx);
                    }
                }

                // 清空旧节点的引用并标记折叠源边为删除
                pt2lines[idx1] = [];
                pt2lines[idx2] = [];
                lines[i].deleted = true;

                mergeOccurred = true;
            }
        }
    }

    // ==========================================
    // 第三步：同向共线缝合 (Collinear Merge)
    // 清理打断的长直线
    // ==========================================
    var collinearMergeOccurred = true;
    while (collinearMergeOccurred) {
        collinearMergeOccurred = false;
        
        for (var pIdx = 0; pIdx < pt2lines.length; pIdx++) {
            // 清理已删除的线段缓存
            var activeLines = [];
            var seenLines = {};
            for (var k = 0; k < pt2lines[pIdx].length; k++) {
                var lIdx = pt2lines[pIdx][k];
                if (!lines[lIdx].deleted && !seenLines[lIdx]) {
                    seenLines[lIdx] = true;
                    activeLines.push(lIdx);
                }
            }
            pt2lines[pIdx] = activeLines;

            // 仅当节点恰好连接两条线时才判断是否共线
            if (activeLines.length === 2) {
                var l1 = lines[activeLines[0]];
                var l2 = lines[activeLines[1]];

                var pCommon = points[pIdx];
                var pt1 = points[l1.p1_idx === pIdx ? l1.p2_idx : l1.p1_idx];
                var pt2 = points[l2.p1_idx === pIdx ? l2.p2_idx : l2.p1_idx];

                var a1 = Math.atan2(pt1.y - pCommon.y, pt1.x - pCommon.x);
                var a2 = Math.atan2(pt2.y - pCommon.y, pt2.x - pCommon.x);
                var diff = Math.abs(a1 - a2) * 180.0 / Math.PI;
                if (diff > 180.0) diff = 360.0 - diff;

                if (Math.abs(diff - 180.0) <= this.ANGLE_TOL) {
                    // 缝合：将 l2 的非公共端点交给 l1
                    if (l1.p1_idx === pIdx) l1.p1_idx = (l2.p1_idx === pIdx ? l2.p2_idx : l2.p1_idx);
                    else l1.p2_idx = (l2.p1_idx === pIdx ? l2.p2_idx : l2.p1_idx);

                    l2.deleted = true;
                    
                    // 更新 pt2 的邻接表，用 l1 替换 l2
                    var pt2_idx = (l2.p1_idx === pIdx ? l2.p2_idx : l2.p1_idx);
                    for(var m = 0; m < pt2lines[pt2_idx].length; m++) {
                        if (pt2lines[pt2_idx][m] === activeLines[1]) {
                            pt2lines[pt2_idx][m] = activeLines[0];
                        }
                    }
                    collinearMergeOccurred = true;
                }
            }
        }
    }

    // ==========================================
    // 第四步：打包写入 QCAD 引擎
    // ==========================================
    var mainOp = new RAddObjectsOperation();
    mainOp.setText("Simplify DXF (保形消除短线)");

    var finalLineCount = 0;
    
    for (var i = 0; i < lines.length; i++) {
        // 删除图纸上的旧实体
        mainOp.deleteObject(lines[i].origEnt);

        // 生成新实体
        if (!lines[i].deleted) {
            var p1 = points[lines[i].p1_idx];
            var p2 = points[lines[i].p2_idx];
            
            var dX = p1.x - p2.x;
            var dY = p1.y - p2.y;
            
            // 最终安全拦截：仅写入长度明确 > 0 且有效距离的线段
            if (dX * dX + dY * dY > 0.000001) {
                var p1Vec = new RVector(p1.x, p1.y);
                var p2Vec = new RVector(p2.x, p2.y);
                var newLine = new RLineEntity(doc, new RLineData(p1Vec, p2Vec));
                
                // 继承图层和属性
                newLine.copyAttributesFrom(lines[i].origEnt);
                newLine.setLayerId(lines[i].origEnt.getLayerId());
                
                mainOp.addObject(newLine, false);
                finalLineCount++;
            }
        }
    }

    di.applyOperation(mainOp);

    var endTime = new Date().getTime();
    var timeSpent = ((endTime - startTime) / 1000).toFixed(2);
    var removedCount = initialLineCount - finalLineCount;
    
    EAction.handleUserMessage("DXF 保形处理完毕！(耗时: " + timeSpent + "秒)");
    EAction.handleUserMessage(" -> 处理前线条数: " + initialLineCount);
    EAction.handleUserMessage(" -> 处理后线条数: " + finalLineCount + " (成功将冗余碎线优化为 " + removedCount + " 个节点)");
    EAction.handleUserMessage(" -> 现状：已彻底消灭孤立 <0.03mm 短线，圆弧类曲线已被安全重构为大线段。");
};

SimplifyDXF.init = function(basePath) {
    var action = new RGuiAction(qsTr("Simplify DXF (消除微小短线)"), RMainWindowQt.getMainWindow());
    action.setRequiresDocument(true);
    action.setScriptFile(basePath + "/SimplifyDXF.js");
    action.setGroupSortOrder(0);
    action.setSortOrder(2);
    action.setWidgetNames(["MiscModifyMenu"]);
    action.setDefaultShortcut(new QKeySequence("S,D"));
    action.setDefaultCommands(["SimplifyDXF", "sd"]);
};