import * as scran from "scran.js";
import * as utils from "./general.js";
import * as aworkers from "./abstract/workers_parent.js";

var animateFun = (x, y, i) => null;

/**
 * Specify a function to handle animation iterations for the low-dimensional embeddings.
 * The exact nature of this handling is arbitrary - developers may post the contents to another thread, save them to file, etc.
 *
 * @param {function} fun - Function to process each animation iteration.
 * This should accept four arguments, in the following order:
 * - A string containing either `"tsne"` or `"umap"`.
 * - A `Float64Array` containing the x-coordinates for each cell.
 * - A `Float64Array` containing the y-coordinates for each cell.
 * - An integer specifying the iteration number.
 *
 * @return `fun` is set as the global animator function for t-SNE and UMAP.
 * The _previous_ value of the animator is returned.
 */
export function setVisualizationAnimate(fun) {
    let previous = animateFun;
    animateFun = fun;
    return previous;
}

export var scranOptions = { numberOfThreads: 1 };

export function computeNeighbors(index, k) {
    var nn_index = index.fetchIndex();

    var output = { "num_obs": nn_index.numberOfCells() };
    var results = null, rbuf = null, ibuf = null, dbuf = null;
    try {
        results = scran.findNearestNeighbors(nn_index, k);

        rbuf = scran.createInt32WasmArray(results.numberOfCells());
        ibuf = scran.createInt32WasmArray(results.size());
        dbuf = scran.createFloat64WasmArray(results.size());

        results.serialize({ runs: rbuf, indices: ibuf, distances: dbuf });
        output["size"] = results.size();
        output["runs"] = rbuf.array().slice();
        output["indices"] = ibuf.array().slice();
        output["distances"] = dbuf.array().slice();

    } finally {
        if (results !== null) {
            results.free();
        }
        if (rbuf !== null) {
            rbuf.free();
        }
        if (ibuf !== null) {
            ibuf.free();
        }
        if (dbuf !== null) {
            dbuf.free();
        }
    }

    return output;
}

const worker_registry = [];
const worker_cache_registry = [];

export function sendTask(worker_id, payload, transferrable = []) {
    let worker = worker_registry[worker_id];
    let cache = worker_cache_registry[worker_id];

    var i = cache.counter;
    var p = new Promise((resolve, reject) => {
        cache.promises[i] = { "resolve": resolve, "reject": reject };
    });

    cache.counter++;
    payload.id = i;
    aworkers.sendMessage(worker, payload, transferrable);
    return p;
}

export function initializeWorker(worker, scranOptions) { 
    let n = worker_registry.length;
    worker_registry.push(worker);
    let cache = { counter: 0, promises: {} };
    worker_cache_registry.push(cache);

    aworkers.registerCallback(worker, msg => {
        var type = msg.data.type;
        if (type.endsWith("_iter")) {
            animateFun(type.slice(0, -5), msg.data.x, msg.data.y, msg.data.iteration);
            return;
        }

        var id = msg.data.id;
        var fun = cache.promises[id];
        if (type == "error") {
            fun.reject(msg.data.error);
        } else {
            fun.resolve(msg.data.data);
        }
        delete cache.promises[id];
    });

    return {
        "worker_id": n,
        "ready": sendTask(n, { "cmd": "INIT", scranOptions: scranOptions })
    };
}

export async function killWorker(worker_id) {
    await sendTask(worker_id, { "cmd": "KILL" });
    let worker = worker_registry[worker_id];
    worker_registry[worker_id] = null;
    return aworkers.terminateWorker(worker);
}

export function killAllWorkers() {
    let p = [];
    for (var i = 0; i < worker_registry.length; i++) {
        if (worker_registry[i] !== null) {
            let p_ = killWorker(i);
            if (p_) { // not null, not undefined.
                p.push(p_);
            }
        }
    }
    return Promise.all(p).then(x => null);
}

export function runWithNeighbors(worker_id, args, nn_out) {
    var run_msg = {
        "cmd": "RUN",
        "params": args 
    };

    var transferrable = [];
    if (nn_out !== null) {
        transferrable = [
            nn_out.runs.buffer,
            nn_out.indices.buffer,
            nn_out.distances.buffer
        ];
        run_msg.neighbors = nn_out;
    }

    return sendTask(worker_id, run_msg, transferrable);
}
