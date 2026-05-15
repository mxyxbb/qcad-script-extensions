include("scripts/EAction.js");

/**
 * QCAD DXF 简化脚本 - 终极清零迭代版
 * 特性：自动循环直到0残留 + 强删阶梯 + 刚性保护 + 90度夹角分流原则
 */
function SimplifyDXF(guiAction) {
    EAction.call(this, guiAction);
    
    this.REMOVE_THRESHOLD = 0.03; 
    this.FIXED_THRESHOLD = 0.1;   
    this.MAX_ITERATIONS = 30; // 最大自动循环迭代次数，足以消化上百万条连续短线
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

    var totalDeletedCount = 0;
    var currentIteration = 0;

    // === 核心：开启全自动迭代循环 ===
    while (currentIteration < this.MAX_ITERATIONS) {
        currentIteration++;
        
        var linesMap = {}; 
        var entityIds = doc.queryAllEntities();
        var shortLineIds = [];

        var getKey = function(pt) {
            return pt.x.toFixed(3) + "," + pt.y.toFixed(3);
        };

        var getAngleDeg = function(p1, p2) {
            return Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180.0 / Math.PI;
        };

        var isStrictHV = function(lineEntity) {
            var p1 = lineEntity.getStartPoint();
            var p2 = lineEntity.getEndPoint();
            var mod90 = Math.abs(getAngleDeg(p1, p2)) % 90.0;
            return (mod90 < 0.1 || mod90 > 89.9);
        };

        // 1. 扫描当前图纸状态
        for (var i = 0; i < entityIds.length; i++) {
            var id = entityIds[i];
            var entity = doc.queryEntity(id);

            if (!isNull(entity) && entity.getType() === RS.EntityLine) {
                var p1 = entity.getStartPoint();
                var p2 = entity.getEndPoint();
                
                var k1 = getKey(p1);
                var k2 = getKey(p2);

                if (!linesMap[k1]) linesMap[k1] = [];
                linesMap[k1].push(id);
                if (!linesMap[k2]) linesMap[k2] = [];
                linesMap[k2].push(id);

                if (p1.getDistanceTo(p2) < this.REMOVE_THRESHOLD) {
                    shortLineIds.push(id);
                }
            }
        }

        // 如果图纸里一根短线都没有了，完美跳出循环！
        if (shortLineIds.length === 0) {
            break; 
        }

        var deleteSet = {};   
        var deleteArray = []; 

        // 2. 筛选删除线条：先强删极短的水平/竖直线
        for (var i = 0; i < shortLineIds.length; i++) {
            var id = shortLineIds[i];
            var ent = doc.queryEntity(id);
            if (!isNull(ent) && isStrictHV(ent)) {
                deleteSet[id] = true;
                deleteArray.push(id);
            }
        }

        // 3. 对剩下的短线执行“隔一删一”降采样
        for (var i = 0; i < shortLineIds.length; i++) {
            var id = shortLineIds[i];
            if (deleteSet[id]) continue; 

            var ent = doc.queryEntity(id);
            if (isNull(ent)) continue;

            var p1 = ent.getStartPoint();
            var p2 = ent.getEndPoint();
            var neighbors = [];
            if (linesMap[getKey(p1)]) neighbors = neighbors.concat(linesMap[getKey(p1)]);
            if (linesMap[getKey(p2)]) neighbors = neighbors.concat(linesMap[getKey(p2)]);

            var adjacentToDeleted = false;
            for (var n = 0; n < neighbors.length; n++) {
                var nid = neighbors[n];
                if (nid !== id && deleteSet[nid]) {
                    adjacentToDeleted = true;
                    break;
                }
            }

            if (!adjacentToDeleted) {
                deleteSet[id] = true;
                deleteArray.push(id);
            }
        }

        // 安全锁：如果未能筛选出任何要删除的线，强行跳出防死循环
        if (deleteArray.length === 0) break;

        // 4. 聚合删除链条
        var chains = [];
        var visited = {};

        for (var i = 0; i < deleteArray.length; i++) {
            var startId = deleteArray[i];
            if (visited[startId]) continue;

            var chain = { deletedIds: [], connectedKeptLines: [] };
            var queue = [startId];
            visited[startId] = true;

            while (queue.length > 0) {
                var currId = queue.shift();
                chain.deletedIds.push(currId);

                var ent = doc.queryEntity(currId);
                var pts = [ent.getStartPoint(), ent.getEndPoint()];

                for (var p = 0; p < 2; p++) {
                    var pt = pts[p];
                    var adjIds = linesMap[getKey(pt)] || [];

                    for (var a = 0; a < adjIds.length; a++) {
                        var adjId = adjIds[a];
                        if (adjId === currId) continue;

                        if (deleteSet[adjId]) {
                            if (!visited[adjId]) {
                                visited[adjId] = true;
                                queue.push(adjId);
                            }
                        } else {
                            var isDup = false;
                            for (var k = 0; k < chain.connectedKeptLines.length; k++) {
                                if (chain.connectedKeptLines[k].id === adjId) isDup = true;
                            }
                            if (!isDup) {
                                chain.connectedKeptLines.push({id: adjId, connectPt: pt});
                            }
                        }
                    }
                }
            }
            chains.push(chain);
        }

        var workingCopies = {};
        var getWorkingCopy = function(id) {
            if (workingCopies[id]) return workingCopies[id];
            var ent = doc.queryEntity(id);
            if (!isNull(ent)) {
                workingCopies[id] = ent.clone();
                return workingCopies[id];
            }
            return null;
        };

        var getEntityLength = function(lineEntity) {
            return lineEntity.getStartPoint().getDistanceTo(lineEntity.getEndPoint());
        };

        var isAngleFixed = function(lineEntity) {
            if (getEntityLength(lineEntity) > this.FIXED_THRESHOLD) return true;
            if (isStrictHV(lineEntity)) return true; 
            return false;
        }.bind(this);

        var getInfiniteLineIntersection = function(p1, p2, p3, p4) {
            var den = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
            if (Math.abs(den) < 1e-6) return null; 
            var nx = (p1.x*p2.y - p1.y*p2.x) * (p3.x - p4.x) - (p1.x - p2.x) * (p3.x*p4.y - p3.y*p4.x);
            var ny = (p1.x*p2.y - p1.y*p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x*p4.y - p3.y*p4.x);
            return new RVector(nx / den, ny / den);
        };

        var getCurrentConnectPt = function(lineEntity, originalConnectPt) {
            var p1 = lineEntity.getStartPoint();
            var p2 = lineEntity.getEndPoint();
            return (p1.getDistanceTo(originalConnectPt) < p2.getDistanceTo(originalConnectPt)) ? p1 : p2;
        };

        var updateClosestEndpoint = function(lineEntity, targetPt, currentConnectPt) {
            var p1 = lineEntity.getStartPoint();
            var p2 = lineEntity.getEndPoint();
            if (p1.getDistanceTo(currentConnectPt) < p2.getDistanceTo(currentConnectPt)) {
                lineEntity.setStartPoint(targetPt);
            } else {
                lineEntity.setEndPoint(targetPt);
            }
        };

        var getVectorAway = function(lineEntity, currentConnectPt) {
            var p1 = lineEntity.getStartPoint();
            var p2 = lineEntity.getEndPoint();
            if (p1.getDistanceTo(currentConnectPt) < p2.getDistanceTo(currentConnectPt)) {
                return new RVector(p2.x - p1.x, p2.y - p1.y);
            } else {
                return new RVector(p1.x - p2.x, p1.y - p2.y);
            }
        };

        var checkSafeExtension = function(lineEntity, currentPt, targetPt) {
            var p1 = lineEntity.getStartPoint();
            var p2 = lineEntity.getEndPoint();
            var otherPt = (p1.getDistanceTo(currentPt) > p2.getDistanceTo(currentPt)) ? p1 : p2;

            var vOrig = new RVector(currentPt.x - otherPt.x, currentPt.y - otherPt.y);
            var vNew = new RVector(targetPt.x - currentPt.x, targetPt.y - currentPt.y);
            var dot = vOrig.x * vNew.x + vOrig.y * vNew.y;

            if (dot < 0) {
                var origLen = currentPt.getDistanceTo(otherPt);
                var trimLen = currentPt.getDistanceTo(targetPt);
                if (trimLen >= origLen * 0.99) return false; 
            }
            return true; 
        };

        // 5. 缝合算法执行区
        var modOp = new RModifyObjectsOperation();
        var delOp = new RDeleteObjectsOperation();
        var addOp = new RAddObjectsOperation(); 

        for (var i = 0; i < chains.length; i++) {
            var chain = chains[i];

            if (chain.connectedKeptLines.length === 2) {
                var l1 = chain.connectedKeptLines[0];
                var l2 = chain.connectedKeptLines[1];

                var wA = getWorkingCopy(l1.id);
                var wB = getWorkingCopy(l2.id);

                if (wA && wB) {
                    var ptA = getCurrentConnectPt(wA, l1.connectPt);
                    var ptB = getCurrentConnectPt(wB, l2.connectPt);

                    var vA = getVectorAway(wA, ptA);
                    var vB = getVectorAway(wB, ptB);
                    var dot = vA.x * vB.x + vA.y * vB.y;
                    var mag = vA.getMagnitude() * vB.getMagnitude();
                    var thetaDeg = 180.0;
                    if (mag > 1e-6) {
                        var cosTheta = Math.max(-1.0, Math.min(1.0, dot / mag));
                        thetaDeg = Math.acos(cosTheta) * 180.0 / Math.PI;
                    }

                    var gapDistance = ptA.getDistanceTo(ptB);
                    var ip = getInfiniteLineIntersection(wA.getStartPoint(), wA.getEndPoint(), wB.getStartPoint(), wB.getEndPoint());

                    var isSafeIP = false;
                    if (ip && ip.isValid()) {
                        var ipDistA = ptA.getDistanceTo(ip);
                        var ipDistB = ptB.getDistanceTo(ip);
                        if (checkSafeExtension(wA, ptA, ip) && checkSafeExtension(wB, ptB, ip)) {
                            var maxMult = (isAngleFixed(wA) && isAngleFixed(wB)) ? 10.0 : 3.0; 
                            if (ipDistA <= gapDistance * maxMult && ipDistB <= gapDistance * maxMult) {
                                isSafeIP = true;
                            }
                        }
                    }

                    var fixedA = isAngleFixed(wA);
                    var fixedB = isAngleFixed(wB);
                    var hvA = isStrictHV(wA);
                    var hvB = isStrictHV(wB);
                    var lenA = getEntityLength(wA);
                    var lenB = getEntityLength(wB);

                    // ==========================================
                    // 核心分流原则应用 (>=90 改变长度, <90 改变端点)
                    // ==========================================
                    if (thetaDeg >= 90.0) {
                        // 优先延伸改变长度
                        if (isSafeIP) {
                            updateClosestEndpoint(wA, ip, ptA);
                            updateClosestEndpoint(wB, ip, ptB);
                        } else {
                            // 无法安全延伸时：
                            // 若桥接会导致死循环(因为桥接线 < 0.03)，则被迫吸附端点。否则画桥。
                            if (fixedA && fixedB && gapDistance >= this.REMOVE_THRESHOLD) {
                                var baseEnt = doc.queryEntity(chain.deletedIds[0]);
                                if (!isNull(baseEnt)) {
                                    var newLine = baseEnt.clone();
                                    newLine.setStartPoint(ptA);
                                    newLine.setEndPoint(ptB);
                                    addOp.addObject(newLine, false);
                                }
                            } else {
                                // 妥协吸附：优先改变较短线条的端点，且绝不改变强刚性(HV)线段
                                if (hvA && !hvB) updateClosestEndpoint(wB, ptA, ptB);
                                else if (!hvA && hvB) updateClosestEndpoint(wA, ptB, ptA);
                                else if (fixedA && !fixedB) updateClosestEndpoint(wB, ptA, ptB);
                                else if (!fixedA && fixedB) updateClosestEndpoint(wA, ptB, ptA);
                                else {
                                    if (lenA < lenB) updateClosestEndpoint(wA, ptB, ptA);
                                    else updateClosestEndpoint(wB, ptA, ptB);
                                }
                            }
                        }
                    } else {
                        // 锐角尖刺 < 90度：优先直接吸附端点
                        if (fixedA && fixedB) {
                            // 即使优先吸附，也不能破坏两条刚性线的角度，被迫退化为延伸或架桥
                            if (isSafeIP) {
                                updateClosestEndpoint(wA, ip, ptA);
                                updateClosestEndpoint(wB, ip, ptB);
                            } else if (gapDistance >= this.REMOVE_THRESHOLD) {
                                var baseEnt = doc.queryEntity(chain.deletedIds[0]);
                                if (!isNull(baseEnt)) {
                                    var newLine = baseEnt.clone();
                                    newLine.setStartPoint(ptA);
                                    newLine.setEndPoint(ptB);
                                    addOp.addObject(newLine, false);
                                }
                            } else {
                                // 极端情况：缝隙极小，无法架桥，必须妥协吸附
                                if (hvA && !hvB) updateClosestEndpoint(wB, ptA, ptB);
                                else if (!hvA && hvB) updateClosestEndpoint(wA, ptB, ptA);
                                else {
                                    if (lenA < lenB) updateClosestEndpoint(wA, ptB, ptA);
                                    else updateClosestEndpoint(wB, ptA, ptB);
                                }
                            }
                        } else {
                            // 只要有一根线不受刚性保护，就可以完美执行锐角吸附指令！
                            if (hvA && !hvB) updateClosestEndpoint(wB, ptA, ptB);
                            else if (!hvA && hvB) updateClosestEndpoint(wA, ptB, ptA);
                            else if (fixedA && !fixedB) updateClosestEndpoint(wB, ptA, ptB);
                            else if (!fixedA && fixedB) updateClosestEndpoint(wA, ptB, ptA);
                            else {
                                if (lenA < lenB) updateClosestEndpoint(wA, ptB, ptA); // 改变A吸附到B
                                else updateClosestEndpoint(wB, ptA, ptB); // 改变B吸附到A
                            }
                        }
                    }
                }
            } 
            else if (chain.connectedKeptLines.length === 1) {
                var l1Single = chain.connectedKeptLines[0];
                var wSingle = getWorkingCopy(l1Single.id);
                if (wSingle) {
                    var ptSingle = getCurrentConnectPt(wSingle, l1Single.connectPt);
                    var furthestPt = ptSingle;
                    var maxDist = 0;
                    for (var j = 0; j < chain.deletedIds.length; j++) {
                        var sEnt = doc.queryEntity(chain.deletedIds[j]);
                        if (!isNull(sEnt)) {
                            var d1 = sEnt.getStartPoint().getDistanceTo(ptSingle);
                            var d2 = sEnt.getEndPoint().getDistanceTo(ptSingle);
                            if (d1 > maxDist) { maxDist = d1; furthestPt = sEnt.getStartPoint(); }
                            if (d2 > maxDist) { maxDist = d2; furthestPt = sEnt.getEndPoint(); }
                        }
                    }
                    updateClosestEndpoint(wSingle, furthestPt, ptSingle);
                }
            }
        }

        // 提交本次迭代的修改操作
        for (var id in workingCopies) {
            modOp.addObject(workingCopies[id], false);
        }
        for (var i = 0; i < deleteArray.length; i++) {
            var entToDel = doc.queryEntity(deleteArray[i]);
            if (!isNull(entToDel)) delOp.deleteObject(entToDel);
        }

        di.applyOperation(modOp);
        di.applyOperation(delOp);
        di.applyOperation(addOp);

        totalDeletedCount += deleteArray.length;
    }

    if (currentIteration >= this.MAX_ITERATIONS) {
        EAction.handleUserMessage("警告：达到最大运算次数上限！已移除 " + totalDeletedCount + " 根短线，但可能仍有极少数残留。");
    } else {
        EAction.handleUserMessage("DXF 终极简化完毕！后台自动运算 " + currentIteration + " 轮，彻底粉碎并重构了 " + totalDeletedCount + " 根微型短线。全图已清零，未发现残留！");
    }
};

// ==========================================
// 插件菜单注册区 
// ==========================================
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