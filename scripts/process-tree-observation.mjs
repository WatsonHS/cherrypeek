const UNKNOWN_CLASSIFICATION = "other-descendant";

export function classifyProcess(command) {
  const name = String(command ?? "").trim().toLowerCase();
  if (name.includes("commitscope-daemon") || /^\(commitscope-daem(?:on)?\)$/.test(name)) return "rust-daemon";
  if (/^\(git\)$/.test(name) || /(?:^|\/)git(?:\s|$)/.test(name)) return "git";
  if (name.includes("electron helper") || name.includes("renderer")) return "electron-renderer-or-helper";
  if (name.includes("electron")) return "electron";
  return UNKNOWN_CLASSIFICATION;
}

export function mergeProcessObservation(previous, current) {
  if (!previous || previous.pid !== current.pid || previous.started !== current.started) {
    return withClassification(current);
  }

  const oldObservation = withClassification(previous);
  const newObservation = withClassification(current);
  const oldKnown = oldObservation.classification !== UNKNOWN_CLASSIFICATION;
  const newKnown = newObservation.classification !== UNKNOWN_CLASSIFICATION;

  if (oldKnown && !newKnown) return oldObservation;
  if (!oldKnown && newKnown) return newObservation;
  if (oldObservation.classification !== newObservation.classification) return newObservation;

  return newObservation.command.length >= oldObservation.command.length ? newObservation : oldObservation;
}

export function aggregateProcessSamples(samples) {
  const observed = new Map();
  for (const sample of samples) {
    for (const processInfo of sample.tree) {
      const key = `${processInfo.pid}:${processInfo.started}`;
      const previous = observed.get(key);
      const identity = mergeProcessObservation(previous, processInfo);
      observed.set(key, {
        ...identity,
        parentPid: processInfo.parentPid,
        peakRssKB: Math.max(previous?.peakRssKB ?? 0, processInfo.rssKB),
        lastCumulativeCpuSeconds: processInfo.cpuSeconds,
        samples: (previous?.samples ?? 0) + 1,
      });
    }
  }
  return [...observed.values()].sort((a, b) => a.pid - b.pid);
}

function withClassification(observation) {
  const classification = classifyProcess(observation.command);
  return { ...observation, classification };
}
