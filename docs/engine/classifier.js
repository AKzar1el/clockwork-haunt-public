                                                                        
                                                

                                 
                       
              
                         
                     
                                             
                           
                         
                
                    
 

/**
 * Classify a single artifact read and return a frozen ArtifactReadRecord.
 * Priority order (AC-006): Fresh → Stale → Unknown → Missing.
 */
export function classifyRead(p                )                     {
  const {
    store, key, requiredWindow, readMinute,
    scheduledPublishMinute, fallbackEnabled, maxArtifactAge,
    jobId, attemptId,
  } = p;

  // ── Fresh (AC-002) ──────────────────────────────────────────────────────
  const exact = store.get(key, requiredWindow);
  if (exact && exact.producerValid) {
    const age = readMinute - exact.publishMinute;
    if (age >= 0 && age <= maxArtifactAge) {
      return freeze({
        jobId, attemptId, key, requiredWindow,
        actualWindowIndex: requiredWindow,
        state: 'Fresh',
        publishMinute: exact.publishMinute,
        readMinute,
        artifactAge: age,
      });
    }
  }

  // ── Stale arm (b): same-window, valid producer, over-age (AC-003b) ──────
  if (exact && exact.producerValid) {
    const age = readMinute - exact.publishMinute;
    if (age > maxArtifactAge) {
      return freeze({
        jobId, attemptId, key, requiredWindow,
        actualWindowIndex: requiredWindow,
        state: 'Stale',
        publishMinute: exact.publishMinute,
        readMinute,
        artifactAge: age,
      });
    }
  }

  // ── Stale arm (a): prior-window fallback, valid producer (AC-003a) ──────
  if (fallbackEnabled) {
    const prior = store.getBestBelow(key, requiredWindow);
    if (prior) {
      const age = readMinute - prior.publishMinute;
      if (!exact && age >= 0) {
        return freeze({
          jobId, attemptId, key, requiredWindow,
          actualWindowIndex: prior.windowIndex,
          state: 'Stale',
          publishMinute: prior.publishMinute,
          readMinute,
          artifactAge: age,
        });
      }
    }
  }

  // ── Unknown arm (b): artifact present but invalid producer (AC-004b) ────
  if (exact && !exact.producerValid) {
    return freeze({
      jobId, attemptId, key, requiredWindow,
      actualWindowIndex: requiredWindow,
      state: 'Unknown',
      publishMinute: null,
      readMinute,
      artifactAge: null,
    });
  }

  // ── Unknown arm (a): no artifact, future scheduled publish (AC-004a) ────
  if (!exact && scheduledPublishMinute !== undefined && scheduledPublishMinute > readMinute) {
    return freeze({
      jobId, attemptId, key, requiredWindow,
      actualWindowIndex: null,
      state: 'Unknown',
      publishMinute: null,
      readMinute,
      artifactAge: null,
    });
  }

  // ── Missing (AC-005) ────────────────────────────────────────────────────
  return freeze({
    jobId, attemptId, key, requiredWindow,
    actualWindowIndex: null,
    state: 'Missing',
    publishMinute: null,
    readMinute,
    artifactAge: null,
  });
}

function freeze(r                    )                     {
  return Object.freeze(r);
}

/** Derive worst-case InputFreshnessStatus across all reads (AC-012). */
export function worstFreshness(
  states             ,
)                                            {
  const rank                            = {
    Fresh: 0, Stale: 1, Unknown: 2, Missing: 3,
  };
  let worst            = 'Fresh';
  for (const s of states) {
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}
