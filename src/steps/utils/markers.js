import * as scran from "scran.js";

export const summaries2int = { "min": 0, "mean": 1, "min_rank": 4 };
export const int2summaries = { 0: "min", 1: "mean", 4: "min_rank" };

export function serializeGroupStats(ihandle, obj, group, { no_summaries = false } = {}) {
    for (const x of [ "means", "detected" ]) {
        let y= obj[x](group, { copy: "hdf5" });
        ihandle.writeDataSet(x, "Float64", null, y);
    }

    for (const i of [ "lfc", "delta_detected", "auc", "cohen" ]) {
        let i0 = i;
        if (i == "delta_detected") {
            i0 = "deltaDetected";
        }

        let extractor = (index) => obj[i0](group, { summary: index, copy: "hdf5" });
        if (no_summaries) {
            let y = extractor(summaries2int["mean"]);
            ihandle.writeDataSet(i, "Float64", null, y);
        } else {
            let curhandle = ihandle.createGroup(i);
            for (const [j, k] of Object.entries(summaries2int)) {
                let y = extractor(k);
                curhandle.writeDataSet(j, "Float64", null, y);
            }
        }
    }
}

export function unserializeGroupStats(handle, permuter, { no_summaries = false } = {}) {
    let output = {};
    for (const x of [ "means", "detected" ]) {
        output[x] = handle.open(x, { load: true }).values;
        permuter(output[x]);
    }

    for (const i of [ "lfc", "delta_detected", "auc", "cohen" ]) {
        if (no_summaries) {
            output[i] = handle.open(i, { load: true }).values;
        } else {
            let rhandle = handle.open(i);
            let current = {};
            for (const j of Object.keys(summaries2int)) {
                current[j] = rhandle.open(j, { load: true }).values;
                permuter(current[j]);
            }
            output[i] = current;
        }
    }

    return output;
}

/**
 * Report marker results for a given group or cluster, ordered so that the strongest candidate markers appear first.
 * This is the function underlying {@linkcode MarkerDetectionState#fetchGroupResults MarkerDetectionState.fetchGroupResults}.
 *
 * @param {ScoreMarkersResults} results - The marker results object generated by the `scoreMarkers` function in **scran.js**.
 * @param {number} group - Integer specifying the group or cluster of interest.
 * Any number can be used if it was part of the `groups` passed to `scoreMarkers`.
 * @param {string} rankEffect - Summarized effect size to use for ranking markers.
 * This should follow the format of `<effect>-<summary>` where `<effect>` may be `lfc`, `cohen`, `auc` or `delta_detected`,
 * and `<summary>` may be `min`, `mean` or `min-rank`.
 *
 * @return An object containing the marker statistics for the selection, sorted by the specified effect and summary size from `rankEffect`.
 * This contains:
 *   - `means`: a `Float64Array` of length equal to the number of genes, containing the mean expression within the selection.
 *   - `detected`: a `Float64Array` of length equal to the number of genes, containing the proportion of cells with detected expression inside the selection.
 *   - `lfc`: a `Float64Array` of length equal to the number of genes, containing the log-fold changes for the comparison between cells inside and outside the selection.
 *   - `delta_detected`: a `Float64Array` of length equal to the number of genes, containing the difference in the detected proportions between cells inside and outside the selection.
 */
export function formatMarkerResults(results, group, rankEffect) {
    if (!rankEffect || rankEffect === undefined) {
        rankEffect = "cohen-min-rank";
    }

    var ordering;
    {
        // Choosing the ranking statistic. Do NOT do any Wasm allocations
        // until 'ranking' is fully consumed!
        let ranking;
        let increasing = false;
      
        let index = 1;
        if (rankEffect.match(/-min$/)) {
            index = 0;
        } else if (rankEffect.match(/-min-rank$/)) {
            increasing = true;
            index = 4;
        }

        if (rankEffect.match(/^cohen-/)) {
            ranking = results.cohen(group, { summary: index, copy: false });
        } else if (rankEffect.match(/^auc-/)) {
            ranking = results.auc(group, { summary: index, copy: false });
        } else if (rankEffect.match(/^lfc-/)) {
            ranking = results.lfc(group, { summary: index, copy: false });
        } else if (rankEffect.match(/^delta-d-/)) {
            ranking = results.deltaDetected(group, { summary: index, copy: false });
        } else {
            throw "unknown rank type '" + rankEffect + "'";
        }
  
        // Computing the ordering based on the ranking statistic.
        ordering = new Int32Array(ranking.length);
        for (var i = 0; i < ordering.length; i++) {
            ordering[i] = i;
        }
        if (increasing) {
            ordering.sort((f, s) => (ranking[f] - ranking[s]));
        } else {
            ordering.sort((f, s) => (ranking[s] - ranking[f]));
        }
    }
  
    // Apply that ordering to each statistic of interest.
    var reorder = function(stats) {
        var thing = new Float64Array(stats.length);
        for (var i = 0; i < ordering.length; i++) {
            thing[i] = stats[ordering[i]];
        }
        return thing;
    };
  
    var stat_detected = reorder(results.detected(group, { copy: false }));
    var stat_mean = reorder(results.means(group, { copy: false }));
    var stat_lfc = reorder(results.lfc(group, { summary: 1, copy: false }));
    var stat_delta_d = reorder(results.deltaDetected(group, { summary: 1, copy: false }));

    return {
        "ordering": ordering,
        "means": stat_mean,
        "detected": stat_detected,
        "lfc": stat_lfc,
        "delta_detected": stat_delta_d
    };
}

export function generateVersusResults(left, right, rank_type, feat_type, cache, generate) {
    if (!("versus" in cache)) {
        cache.versus = {};
    }
    let versus = cache.versus;

    let bigg = (left < right ? right : left);
    let smal = (left < right ? left : right); 

    if (!(bigg in versus)) {
        versus[bigg] = {};
    }
    let biggversus = versus[bigg];

    if (!(smal in biggversus)) {
        biggversus[smal] = {};
    }
    let smalversus = biggversus[smal];

    if (!(feat_type in smalversus)) {
        smalversus[feat_type] = generate(smal, bigg);
    }
    return formatMarkerResults(smalversus[feat_type], (left < right ? 0 : 1), rank_type + "-mean"); 
}

export function freeVersusResults(cache) {
    if ("versus" in cache) {
        for (const v of Object.values(cache.versus)) {
            for (const v2 of Object.values(v)) {
                for (const m of Object.values(v2)) {
                    scran.free(m);
                }
            }
        }
        delete cache.versus;
    }
}

export function dropUnusedBlocks(x) {
    let counter = 0;
    let mapping = {};
    x.forEach((y, i) => {
        if (!(y in mapping)) {
            mapping[y] = counter;
            counter++;
        }
        x[i] = mapping[y];
    });
}