import { writeFile } from "node:fs/promises";

/** Diagnostics run AFTER the ordinary measurements; heap snapshots may trigger GC. */
export async function diagnoseRendererRetention({ app, page, outputPath, sampleTree, cycle }) {
  const cdp = await page.context().newCDPSession(page);
  const result = { note: "Diagnostic only: heap snapshots may collect garbage; do not use these RSS values as normal idle acceptance.", samples: [] };
  const sample = async label => ({ label, tree: await sampleTree(), heap: await cdp.send("Runtime.getHeapUsage"),
    dom: await cdp.send("Memory.getDOMCounters"), mainHeap: await app.evaluate(() => process.memoryUsage()),
    view: await page.locator('[role="listbox"][aria-label="提交"]').evaluate(element => ({ offset: element.dataset.loadedOffset,
      count: element.dataset.loadedCount, domRows: element.querySelectorAll('[data-testid="commit-row"]').length })) });
  try {
    await cdp.send("HeapProfiler.enable");
    result.samples.push(await sample("before-snapshot"));
    result.before = await snapshot(cdp, `${outputPath}.before.heapsnapshot`);
    result.samples.push(await sample("after-baseline-snapshot"));
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    result.cycles = [];
    for (let index = 0; index < 3; index += 1) {
      result.cycles.push(await cycle());
      result.samples.push(await sample(`cycle-${index + 1}`));
    }
    const { profile } = await cdp.send("HeapProfiler.stopSampling");
    result.allocationProfile = `${outputPath}.allocations.json`;
    await writeFile(result.allocationProfile, JSON.stringify(profile), { flag: "wx" });
    const allocations = [];
    const visit = (node, stack) => {
      const frame = node.callFrame;
      const path = [...stack, frame.functionName || "(anonymous)"];
      if (node.selfSize) allocations.push({ bytes: node.selfSize, function: frame.functionName,
        url: frame.url, line: frame.lineNumber, column: frame.columnNumber, stack: path.slice(-8) });
      for (const child of node.children ?? []) visit(child, path);
    };
    visit(profile.head, []);
    result.sampledAllocationBytes = allocations.reduce((sum, row) => sum + row.bytes, 0);
    result.topAllocations = allocations.sort((a, b) => b.bytes - a.bytes).slice(0, 20);
    result.after = await snapshot(cdp, `${outputPath}.after.heapsnapshot`);
    result.samples.push(await sample("after-final-snapshot"));
    return result;
  } finally {
    await cdp.detach();
  }
}

async function snapshot(cdp, path) {
  const chunks = [];
  const onChunk = ({ chunk }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try { await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }); }
  finally { cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk); }
  const contents = chunks.join("");
  await writeFile(path, contents, { flag: "wx" });
  return { path, ...summarizeHeap(JSON.parse(contents)) };
}

function summarizeHeap(heap) {
  const { nodes, edges, strings } = heap;
  const fields = heap.snapshot.meta.node_fields, edgeFields = heap.snapshot.meta.edge_fields;
  const stride = fields.length, edgeStride = edgeFields.length;
  const typeIndex = fields.indexOf("type"), nameIndex = fields.indexOf("name"), sizeIndex = fields.indexOf("self_size");
  const edgeCountIndex = fields.indexOf("edge_count"), detachedIndex = fields.indexOf("detachedness");
  const types = heap.snapshot.meta.node_types[typeIndex];
  const edgeTypeIndex = edgeFields.indexOf("type"), edgeNameIndex = edgeFields.indexOf("name_or_index");
  const edgeTypes = heap.snapshot.meta.edge_types[edgeTypeIndex];
  const shapes = { historyCommits: 0, graphRows: 0, refs: 0, historyPages: 0 };
  const groups = new Map();
  let edgeOffset = 0, selfBytes = 0, detachedNodes = 0;
  for (let node = 0; node < nodes.length; node += stride) {
    const type = types[nodes[node + typeIndex]], name = strings[nodes[node + nameIndex]];
    const size = nodes[node + sizeIndex], count = nodes[node + edgeCountIndex];
    selfBytes += size;
    if (detachedIndex >= 0 && nodes[node + detachedIndex] === 2) detachedNodes += 1;
    const key = `${type}:${name}`;
    const group = groups.get(key) ?? { type, name, count: 0, selfBytes: 0 };
    group.count += 1; group.selfBytes += size; groups.set(key, group);
    if (type === "object") {
      const properties = new Set();
      for (let i = 0; i < count; i += 1) {
        const edge = edgeOffset + i * edgeStride;
        if (edgeTypes[edges[edge + edgeTypeIndex]] === "property") properties.add(strings[edges[edge + edgeNameIndex]]);
      }
      if (properties.has("committer") && properties.has("graph") && properties.has("oid")) shapes.historyCommits += 1;
      if (properties.has("lane") && properties.has("segments") && properties.has("hiddenLaneCount")) shapes.graphRows += 1;
      if (properties.has("peeledOid") && properties.has("name") && properties.has("oid")) shapes.refs += 1;
      if (properties.has("commits") && properties.has("cursor") && properties.has("pageSize")) shapes.historyPages += 1;
    }
    edgeOffset += count * edgeStride;
  }
  return { nodeCount: nodes.length / stride, selfBytes, detachedNodes, shapes,
    largestGroups: [...groups.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, 20) };
}
