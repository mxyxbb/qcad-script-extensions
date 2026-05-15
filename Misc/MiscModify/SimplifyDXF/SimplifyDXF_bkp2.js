include("scripts/EAction.js");

/**
 * QCAD DXF 简化脚本 - V9 拓扑无损终极版 (Topology Safe Engine)
 * 特性：
 * 1. 同向碎片无损融合 (完美修复斜线断裂，保持100%原角度)
 * 2. 严格正交阶梯拉平 (仅对0/90度线生效，杜绝斜线扭曲)
 * 3. 彻底避免延伸错位刺穿现象
 */
function SimplifyDXF(guiAction) {
    EAction.call(this, guiAction);
    
    this.TOLERANCE = 0.005;         // 节点合并的物理容差 (微米级)
    this.COLLINEAR_TOL = 0.5;       // 共线判定角度容差 (度)
    this.SHORT_TOL = 0.03;          // 阶梯短线判定阈值
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

    var totalMerged = 0;
    var fixedSteps = 0;

    // --- 高速空间网格桶构造器 ---
    var buildBuckets = function(docIds) {
        var buckets = [];
        var grid = {};
        var cellSize = this.TOLERANCE * 2.0;

        var getOrAddBucket = function(pt) {
            var cx = Math.floor(pt.x / cellSize);
            var cy = Math.floor(pt.y / cellSize);
            // 搜索 3x3 邻近网格进行捕捉合并
            for (var dx = -1; dx <= 1; dx++) {
                for (var dy = -1; dy <= 1; dy++) {
                    var cell = grid[(cx + dx) + "_" + (cy + dy)];
                    if (cell) {
                        for (var k = 0; k < cell.length; k++) {
                            if (cell[k].pt.getDistanceTo(pt) < this.TOLERANCE) {
                                return cell[k];
                            }
                        }
                    }
                }
            }
            // 未找到则新建 Bucket
            var newBucket = { pt: pt, lines: [] };
            var key = cx + "_" + cy;
            if (!grid[key]) grid[key] = [];
            grid[key].push(newBucket);
            buckets.push(newBucket);
            return newBucket;
        }.bind(this);

        for (var i = 0; i < docIds.length; i++) {
            var ent = doc.queryEntity(docIds[i]);
            if (!isNull(ent) && ent.getType() === RS.EntityLine) {
                var p1 = ent.getStartPoint();
                var p2 = ent.getEndPoint();
                var b1 = getOrAddBucket(p1);
                var b2 = getOrAddBucket(p2);
                b1.lines.push({ id: docIds[i], isStart: true, sharedPt: p1, otherPt: p2 });
                b2.lines.push({ id: docIds[i], isStart: false, sharedPt: p2, otherPt: p1 });
            }
        }
        return { buckets: buckets, getBucket: getOrAddBucket };
    }.bind(this);

    // ==========================================
    // 阶段 1：同向碎片无损融合 (多次循环直到无法合并)
    // ==========================================
    var runCollinearMerge = function() {
        var loopMerged = 0;
        var iterations = 0;
        while (iterations < 20) { // 防止死循环的安全锁
            iterations++;
            var allIds = doc.queryAllEntities();
            var bRes = buildBuckets(allIds);
            var buckets = bRes.buckets;
            
            var toDelete = {};
            var toAdd = [];
            var roundMerged = 0;

            for (var i = 0; i < buckets.length; i++) {
                var bucket = buckets[i];
                if (bucket.lines.length === 2) {
                    var l1 = bucket.lines[0];
                    var l2 = bucket.lines[1];

                    if (toDelete[l1.id] || toDelete[l2.id] || l1.id === l2.id) continue;

                    // 计算夹角
                    var vAx = l1.sharedPt.x - l1.otherPt.x;
                    var vAy = l1.sharedPt.y - l1.otherPt.y;
                    var vBx = l2.otherPt.x - l2.sharedPt.x;
                    var vBy = l2.otherPt.y - l2.sharedPt.y;

                    var angA = Math.atan2(vAy, vAx) * 180.0 / Math.PI;
                    var angB = Math.atan2(vBy, vBx) * 180.0 / Math.PI;
                    var diff = Math.abs(angA - angB) % 360.0;
                    if (diff > 180.0) diff = 360.0 - diff;

                    // 核心：如果几乎共线，则无损融合！
                    if (diff < this.COLLINEAR_TOL) {
                        toDelete[l1.id] = true;
                        toDelete[l2.id] = true;
                        var newLine = new RLineEntity(doc, new RLineData(l1.otherPt, l2.otherPt));
                        var origEnt = doc.queryEntity(l1.id);
                        if (!isNull(origEnt)) {
                            newLine.setLayerId(origEnt.getLayerId());
                            newLine.copyAttributesFrom(origEnt);
                        }
                        toAdd.push(newLine);
                        roundMerged++;
                    }
                }
            }

            if (roundMerged === 0) break;

            var delOp = new RDeleteObjectsOperation();
            for (var id in toDelete) {
                var ent = doc.queryEntity(parseInt(id));
                if (!isNull(ent)) delOp.deleteObject(ent);
            }
            var addOp = new RAddObjectsOperation();
            for (var a = 0; a < toAdd.length; a++) addOp.addObject(toAdd[a], false);

            di.applyOperation(delOp);
            di.applyOperation(addOp);
            loopMerged += roundMerged;
        }
        return loopMerged;
    }.bind(this);

    totalMerged += runCollinearMerge();
    EAction.handleUserMessage("阶段 1 完成：无损融合了 " + totalMerged + " 根破碎的直线/斜线。");

    // ==========================================
    // 阶段 2：正交阶梯专杀 (仅对水平/垂直线进行强制拉平)
    // ==========================================
    var allIdsForStep = doc.queryAllEntities();
    var bResStep = buildBuckets(allIdsForStep);
    var mapStep = bResStep.buckets;
    var getBucket = bResStep.getBucket;

    var toDeleteSteps = {};
    var modifiedCopies = {};

    var isH = function(ent) {
        var a = Math.abs(Math.atan2(ent.getEndPoint().y - ent.getStartPoint().y, ent.getEndPoint().x - ent.getStartPoint().x) * 180.0 / Math.PI) % 180.0;
        return a < 1.0 || a > 179.0;
    };
    var isV = function(ent) {
        var a = Math.abs(Math.atan2(ent.getEndPoint().y - ent.getStartPoint().y, ent.getEndPoint().x - ent.getStartPoint().x) * 180.0 / Math.PI) % 180.0;
        return Math.abs(a - 90.0) < 1.0;
    };

    for (var i = 0; i < allIdsForStep.length; i++) {
        var id = allIdsForStep[i];
        if (toDeleteSteps[id]) continue;
        var ent = doc.queryEntity(id);
        if (isNull(ent) || ent.getType() !== RS.EntityLine) continue;

        var len = ent.getStartPoint().getDistanceTo(ent.getEndPoint());
        if (len > 0 && len < this.SHORT_TOL) {
            var b1 = getBucket(ent.getStartPoint());
            var b2 = getBucket(ent.getEndPoint());

            var neighbors1 = b1.lines.filter(function(n) { return n.id !== id && !toDeleteSteps[n.id]; });
            var neighbors2 = b2.lines.filter(function(n) { return n.id !== id && !toDeleteSteps[n.id]; });

            if (neighbors1.length === 1 && neighbors2.length === 1) {
                var n1 = neighbors1[0];
                var n2 = neighbors2[0];
                var ent1 = modifiedCopies[n1.id] || doc.queryEntity(n1.id).clone();
                var ent2 = modifiedCopies[n2.id] || doc.queryEntity(n2.id).clone();

                var h1 = isH(ent1), v1 = isV(ent1);
                var h2 = isH(ent2), v2 = isV(ent2);
                var handled = false;

                // ★ 仅在两者都是水平、都是垂直，或一横一竖时处理！彻底放过斜线！
                if (h1 && h2) {
                    var avgY = (ent1.getStartPoint().y + ent1.getEndPoint().y + ent2.getStartPoint().y + ent2.getEndPoint().y) / 4.0;
                    var midX = (b1.pt.x + b2.pt.x) / 2.0;

                    var newE1 = ent1.clone();
                    if (n1.isStart) {
                        newE1.setStartPoint(new RVector(midX, avgY));
                        newE1.setEndPoint(new RVector(newE1.getEndPoint().x, avgY));
                    } else {
                        newE1.setEndPoint(new RVector(midX, avgY));
                        newE1.setStartPoint(new RVector(newE1.getStartPoint().x, avgY));
                    }

                    var newE2 = ent2.clone();
                    if (n2.isStart) {
                        newE2.setStartPoint(new RVector(midX, avgY));
                        newE2.setEndPoint(new RVector(newE2.getEndPoint().x, avgY));
                    } else {
                        newE2.setEndPoint(new RVector(midX, avgY));
                        newE2.setStartPoint(new RVector(newE2.getStartPoint().x, avgY));
                    }

                    modifiedCopies[n1.id] = newE1;
                    modifiedCopies[n2.id] = newE2;
                    handled = true;
                } 
                else if (v1 && v2) {
                    var avgX = (ent1.getStartPoint().x + ent1.getEndPoint().x + ent2.getStartPoint().x + ent2.getEndPoint().x) / 4.0;
                    var midY = (b1.pt.y + b2.pt.y) / 2.0;

                    var newE1 = ent1.clone();
                    if (n1.isStart) {
                        newE1.setStartPoint(new RVector(avgX, midY));
                        newE1.setEndPoint(new RVector(avgX, newE1.getEndPoint().y));
                    } else {
                        newE1.setEndPoint(new RVector(avgX, midY));
                        newE1.setStartPoint(new RVector(avgX, newE1.getStartPoint().y));
                    }

                    var newE2 = ent2.clone();
                    if (n2.isStart) {
                        newE2.setStartPoint(new RVector(avgX, midY));
                        newE2.setEndPoint(new RVector(avgX, newE2.getEndPoint().y));
                    } else {
                        newE2.setEndPoint(new RVector(avgX, midY));
                        newE2.setStartPoint(new RVector(avgX, newE2.getStartPoint().y));
                    }

                    modifiedCopies[n1.id] = newE1;
                    modifiedCopies[n2.id] = newE2;
                    handled = true;
                }
                else if ((h1 && v2) || (v1 && h2)) {
                    var ipX = v1 ? ent1.getStartPoint().x : ent2.getStartPoint().x;
                    var ipY = h1 ? ent1.getStartPoint().y : ent2.getStartPoint().y;
                    var ip = new RVector(ipX, ipY);

                    var newE1 = ent1.clone();
                    if (n1.isStart) newE1.setStartPoint(ip);
                    else newE1.setEndPoint(ip);

                    var newE2 = ent2.clone();
                    if (n2.isStart) newE2.setStartPoint(ip);
                    else newE2.setEndPoint(ip);

                    modifiedCopies[n1.id] = newE1;
                    modifiedCopies[n2.id] = newE2;
                    handled = true;
                }

                if (handled) {
                    toDeleteSteps[id] = true;
                    fixedSteps++;
                }
            }
        }
    }

    if (fixedSteps > 0) {
        var modOp = new RModifyObjectsOperation();
        for (var k in modifiedCopies) modOp.addObject(modifiedCopies[k], false);
        var delOp = new RDeleteObjectsOperation();
        for (var k in toDeleteSteps) {
            var entDel = doc.queryEntity(parseInt(k));
            if (!isNull(entDel)) delOp.deleteObject(entDel);
        }
        di.applyOperation(modOp);
        di.applyOperation(delOp);
    }

    // 阶段 3：阶梯拉平后，可能会产生新的共线段，再执行一次融合清理残局
    var cleanupMerged = runCollinearMerge();
    
    EAction.handleUserMessage("DXF 拓扑精简完毕！");
    EAction.handleUserMessage(" -> 无损合并同向碎片：" + (totalMerged + cleanupMerged) + " 处 (保护所有斜角)。");
    EAction.handleUserMessage(" -> 强制拉平正交阶梯：" + fixedSteps + " 处 (完全消除横竖线抖动)。");
};

SimplifyDXF.init = function(basePath) {
    var action = new RGuiAction(qsTr("Simplify DXF (简化短线)"), RMainWindowQt.getMainWindow());
    action.setRequiresDocument(true);
    action.setScriptFile(basePath + "/SimplifyDXF.js");
    action.setGroupSortOrder(0);
    action.setSortOrder(2);
    action.setWidgetNames(["MiscModifyMenu"]);
    action.setDefaultShortcut(new QKeySequence("S,D"));
    action.setDefaultCommands(["SimplifyDXF", "sd"]);
};