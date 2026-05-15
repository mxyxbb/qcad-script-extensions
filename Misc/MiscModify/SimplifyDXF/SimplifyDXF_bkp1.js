include("scripts/EAction.js");

/**
 * QCAD DXF 简化脚本 - V4 强力容差焊接版
 * 特性：短线剔除 + 模糊节点识别 + 全局微缝强行闭合 + 强制水平/垂直拉平
 */
function SimplifyDXF(guiAction) {
    EAction.call(this, guiAction);
    
    this.REMOVE_THRESHOLD = 0.03;   // 短线删除阈值
    this.CONNECT_TOLERANCE = 0.005; // 节点相连的浮点容差 (5微米)
    this.GAP_TOLERANCE = 0.05;      // ★ 新增：游离断口强制焊接的最大间隙 (50微米)
    this.MAX_ITERATIONS = 20; 
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

    // 工具函数
    var getAngleDeg = function(p1, p2) {
        return Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180.0 / Math.PI;
    };
    var isStrictHV = function(lineEntity) {
        var mod90 = Math.abs(getAngleDeg(lineEntity.getStartPoint(), lineEntity.getEndPoint())) % 90.0;
        return (mod90 < 0.1 || mod90 > 89.9);
    };
    var isHorizontal = function(lineEntity) {
        var ang = Math.abs(getAngleDeg(lineEntity.getStartPoint(), lineEntity.getEndPoint())) % 180.0;
        return (ang < 0.5 || ang > 179.5);
    };
    var isVertical = function(lineEntity) {
        var ang = Math.abs(getAngleDeg(lineEntity.getStartPoint(), lineEntity.getEndPoint())) % 180.0;
        return Math.abs(ang - 90.0) < 0.5;
    };
    var getEntityLength = function(lineEntity) {
        return lineEntity.getStartPoint().getDistanceTo(lineEntity.getEndPoint());
    };
    var getCurrentConnectPt = function(lineEntity, originalConnectPt) {
        var p1 = lineEntity.getStartPoint();
        var p2 = lineEntity.getEndPoint();
        return (p1.getDistanceTo(originalConnectPt) < p2.getDistanceTo(originalConnectPt)) ? p1 : p2;
    };
    var updateClosestEndpoint = function(lineEntity, targetPt, referencePt) {
        var p1 = lineEntity.getStartPoint();
        var p2 = lineEntity.getEndPoint();
        if (p1.getDistanceTo(referencePt) < p2.getDistanceTo(referencePt)) {
            lineEntity.setStartPoint(targetPt);
        } else {
            lineEntity.setEndPoint(targetPt);
        }
    };
    var getInfiniteLineIntersection = function(p1, p2, p3, p4) {
        var den = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
        if (Math.abs(den) < 1e-6) return null; 
        var nx = (p1.x*p2.y - p1.y*p2.x) * (p3.x - p4.x) - (p1.x - p2.x) * (p3.x*p4.y - p3.y*p4.x);
        var ny = (p1.x*p2.y - p1.y*p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x*p4.y - p3.y*p4.x);
        return new RVector(nx / den, ny / den);
    };

    // ==========================================
    // 阶段 1：循环剔除微小短线并缝合
    // ==========================================
    while (currentIteration < this.MAX_ITERATIONS) {
        currentIteration++;
        
        var entityIds = doc.queryAllEntities();
        var shortLineIds = [];
        var spatialMap = []; // 空间哈希表，用于模糊匹配

        // 建立空间索引
        for (var i = 0; i < entityIds.length; i++) {
            var id = entityIds[i];
            var entity = doc.queryEntity(id);
            if (!isNull(entity) && entity.getType() === RS.EntityLine) {
                var p1 = entity.getStartPoint();
                var p2 = entity.getEndPoint();
                spatialMap.push({id: id, pt: p1});
                spatialMap.push({id: id, pt: p2});
                if (p1.getDistanceTo(p2) < this.REMOVE_THRESHOLD) {
                    shortLineIds.push(id);
                }
            }
        }

        if (shortLineIds.length === 0) break; // 没有短线了，跳出循环

        var deleteSet = {};   
        var deleteArray = []; 

        // 强删极短 HV 线
        for (var i = 0; i < shortLineIds.length; i++) {
            var id = shortLineIds[i];
            var ent = doc.queryEntity(id);
            if (!isNull(ent) && isStrictHV(ent)) {
                deleteSet[id] = true;
                deleteArray.push(id);
            }
        }

        // 降采样删除斜线
        for (var i = 0; i < shortLineIds.length; i++) {
            var id = shortLineIds[i];
            if (deleteSet[id]) continue; 

            var ent = doc.queryEntity(id);
            if (isNull(ent)) continue;

            var p1 = ent.getStartPoint();
            var p2 = ent.getEndPoint();
            var adjacentToDeleted = false;

            for (var s = 0; s < spatialMap.length; s++) {
                if (spatialMap[s].id !== id) {
                    if ((spatialMap[s].pt.getDistanceTo(p1) < this.CONNECT_TOLERANCE || 
                         spatialMap[s].pt.getDistanceTo(p2) < this.CONNECT_TOLERANCE) && 
                        deleteSet[spatialMap[s].id]) {
                        adjacentToDeleted = true;
                        break;
                    }
                }
            }

            if (!adjacentToDeleted) {
                deleteSet[id] = true;
                deleteArray.push(id);
            }
        }

        if (deleteArray.length === 0) break;

        var chains = [];
        var visited = {};

        // 聚合删除链条
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
                    for (var s = 0; s < spatialMap.length; s++) {
                        var adjId = spatialMap[s].id;
                        if (adjId === currId) continue;

                        if (spatialMap[s].pt.getDistanceTo(pt) < this.CONNECT_TOLERANCE) {
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
                                    chain.connectedKeptLines.push({id: adjId, connectPt: spatialMap[s].pt});
                                }
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

        var modOp = new RModifyObjectsOperation();
        var delOp = new RDeleteObjectsOperation();

        // 执行缝合
        for (var i = 0; i < chains.length; i++) {
            var chain = chains[i];
            if (chain.connectedKeptLines.length >= 2) {
                var sortedLines = chain.connectedKeptLines.slice().sort(function(a, b) {
                    var wA = getWorkingCopy(a.id);
                    var wB = getWorkingCopy(b.id);
                    var scoreA = (isStrictHV(wA) ? 1000 : 0) + getEntityLength(wA);
                    var scoreB = (isStrictHV(wB) ? 1000 : 0) + getEntityLength(wB);
                    return scoreB - scoreA;
                });

                if (sortedLines.length >= 2) {
                    var l1 = sortedLines[0]; 
                    var l2 = sortedLines[1]; 
                    var w1 = getWorkingCopy(l1.id);
                    var w2 = getWorkingCopy(l2.id);

                    var ip = getInfiniteLineIntersection(w1.getStartPoint(), w1.getEndPoint(), w2.getStartPoint(), w2.getEndPoint());
                    
                    if (ip && ip.isValid()) {
                        updateClosestEndpoint(w1, ip, l1.connectPt);
                        updateClosestEndpoint(w2, ip, l2.connectPt);
                    } else {
                        // 平行线直接吸附到平均点
                        var avgPt = new RVector((l1.connectPt.x + l2.connectPt.x)/2, (l1.connectPt.y + l2.connectPt.y)/2);
                        updateClosestEndpoint(w1, avgPt, l1.connectPt);
                        updateClosestEndpoint(w2, avgPt, l2.connectPt);
                    }
                }
            }
        }

        for (var id in workingCopies) modOp.addObject(workingCopies[id], false);
        for (var i = 0; i < deleteArray.length; i++) {
            var entToDel = doc.queryEntity(deleteArray[i]);
            if (!isNull(entToDel)) delOp.deleteObject(entToDel);
        }

        di.applyOperation(modOp);
        di.applyOperation(delOp);
        totalDeletedCount += deleteArray.length;
    }

    // ==========================================
    // ★ 阶段 2：全局游离断口强行焊接 (Gap Sealing) ★
    // ==========================================
    var allEntityIds = doc.queryAllEntities();
    var endpoints = [];
    
    // 收集所有端点
    for (var i = 0; i < allEntityIds.length; i++) {
        var id = allEntityIds[i];
        var entity = doc.queryEntity(id);
        if (!isNull(entity) && entity.getType() === RS.EntityLine) {
            endpoints.push({id: id, pt: entity.getStartPoint()});
            endpoints.push({id: id, pt: entity.getEndPoint()});
        }
    }

    var openEndpoints = [];
    // 寻找“游离”端点（周围 0.005mm 内没有其他线的端点）
    for (var i = 0; i < endpoints.length; i++) {
        var ep = endpoints[i];
        var connectionCount = 0;
        for (var j = 0; j < endpoints.length; j++) {
            if (ep.pt.getDistanceTo(endpoints[j].pt) < this.CONNECT_TOLERANCE) {
                connectionCount++;
            }
        }
        if (connectionCount === 1) { // 只有自己，说明是游离的
            openEndpoints.push(ep);
        }
    }

    var gapModOp = new RModifyObjectsOperation();
    var gapWorkingCopies = {};
    var getGapWorkingCopy = function(id) {
        if (gapWorkingCopies[id]) return gapWorkingCopies[id];
        var ent = doc.queryEntity(id);
        if (!isNull(ent)) {
            gapWorkingCopies[id] = ent.clone();
            return gapWorkingCopies[id];
        }
        return null;
    };

    var matchedOpen = {};
    var sealedGaps = 0;

    // 扫描游离端点，只要距离 < GAP_TOLERANCE (0.05)，强行焊接
    for (var i = 0; i < openEndpoints.length; i++) {
        var ep1 = openEndpoints[i];
        if (matchedOpen[i]) continue;

        var bestMatchIdx = -1;
        var minGapDist = this.GAP_TOLERANCE;

        for (var j = i + 1; j < openEndpoints.length; j++) {
            if (matchedOpen[j]) continue;
            var ep2 = openEndpoints[j];
            if (ep1.id === ep2.id) continue; // 同一条线的两端不能连

            var dist = ep1.pt.getDistanceTo(ep2.pt);
            if (dist < minGapDist) {
                minGapDist = dist;
                bestMatchIdx = j;
            }
        }

        if (bestMatchIdx !== -1) {
            var ep2 = openEndpoints[bestMatchIdx];
            matchedOpen[i] = true;
            matchedOpen[bestMatchIdx] = true;

            var w1 = getGapWorkingCopy(ep1.id);
            var w2 = getGapWorkingCopy(ep2.id);

            var h1 = isHorizontal(w1);
            var v1 = isVertical(w1);
            var h2 = isHorizontal(w2);
            var v2 = isVertical(w2);

            // 强力对齐逻辑
            if (h1 && h2) {
                // 两条都是水平线：强行把短线的 Y 坐标拉平到长线的 Y 坐标，消除阶梯！
                var targetY = getEntityLength(w1) > getEntityLength(w2) ? w1.getStartPoint().y : w2.getStartPoint().y;
                w1.setStartPoint(new RVector(w1.getStartPoint().x, targetY));
                w1.setEndPoint(new RVector(w1.getEndPoint().x, targetY));
                w2.setStartPoint(new RVector(w2.getStartPoint().x, targetY));
                w2.setEndPoint(new RVector(w2.getEndPoint().x, targetY));
                
                var midX = (ep1.pt.x + ep2.pt.x) / 2.0;
                updateClosestEndpoint(w1, new RVector(midX, targetY), ep1.pt);
                updateClosestEndpoint(w2, new RVector(midX, targetY), ep2.pt);
                sealedGaps++;
            } 
            else if (v1 && v2) {
                // 两条都是竖直线：消除 X 轴错位阶梯
                var targetX = getEntityLength(w1) > getEntityLength(w2) ? w1.getStartPoint().x : w2.getStartPoint().x;
                w1.setStartPoint(new RVector(targetX, w1.getStartPoint().y));
                w1.setEndPoint(new RVector(targetX, w1.getEndPoint().y));
                w2.setStartPoint(new RVector(targetX, w2.getStartPoint().y));
                w2.setEndPoint(new RVector(targetX, w2.getEndPoint().y));

                var midY = (ep1.pt.y + ep2.pt.y) / 2.0;
                updateClosestEndpoint(w1, new RVector(targetX, midY), ep1.pt);
                updateClosestEndpoint(w2, new RVector(targetX, midY), ep2.pt);
                sealedGaps++;
            }
            else {
                // 一横一竖，或者有斜线：直接计算数学交点，强行延伸闭合
                var ip = getInfiniteLineIntersection(w1.getStartPoint(), w1.getEndPoint(), w2.getStartPoint(), w2.getEndPoint());
                if (ip && ip.isValid()) {
                    updateClosestEndpoint(w1, ip, ep1.pt);
                    updateClosestEndpoint(w2, ip, ep2.pt);
                } else {
                    var avgPt = new RVector((ep1.pt.x + ep2.pt.x) / 2.0, (ep1.pt.y + ep2.pt.y) / 2.0);
                    updateClosestEndpoint(w1, avgPt, ep1.pt);
                    updateClosestEndpoint(w2, avgPt, ep2.pt);
                }
                sealedGaps++;
            }
        }
    }

    for (var id in gapWorkingCopies) gapModOp.addObject(gapWorkingCopies[id], false);
    di.applyOperation(gapModOp);

    EAction.handleUserMessage("DXF 终极修补完毕！删除短线 " + totalDeletedCount + " 根。全局扫描并强制焊接了 " + sealedGaps + " 处隐形微缝断口！");
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