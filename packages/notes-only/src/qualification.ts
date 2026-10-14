/** Human decisions and operational evidence remain explicit, distinct from structural validation. */
export type HumanReview = {
  sourceHash: string;
  referenceArtifactHash: string;
  candidateArtifactHash: string;
  reviewer: string;
  accepted: boolean;
  criticalErrors: string[];
  rejectionReasons: string[];
  fullyHebrew: boolean;
  subjects: string[];
  speaker: string;
  durationSeconds: number;
};
export type Qualification = {
  profile: string;
  phase: 'quality' | 'production';
  reviews: HumanReview[];
  cohorts?: Array<{
    size: number;
    verifiedPublications: number;
    hashesVerified: boolean;
    manifest: string;
  }>;
  observation?: {
    hours: number;
    verifiedPublications: number;
    referencePerHour: number;
    candidatePerHour: number;
    recoveryPassed: boolean;
    manifest: string;
  };
  concurrency: number;
  memoryPeakBytes: number;
  waivers?: {
    humanReview?: true;
    observation24h?: true;
    requestedBy: 'user';
    instruction: string;
    recordedAt: number;
  };
};
export function validateQualification(e: Qualification) {
  const hash = (x: unknown) =>
    typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  if (
    e.waivers &&
    (e.waivers.requestedBy !== 'user' ||
      !e.waivers.instruction?.trim() ||
      !Number.isSafeInteger(e.waivers.recordedAt) ||
      e.waivers.recordedAt <= 0 ||
      ![undefined, true].includes(e.waivers.humanReview) ||
      ![undefined, true].includes(e.waivers.observation24h))
  )
    throw new Error('Waivers require the explicit recorded user instruction.');
  if (
    !hash(e.profile) ||
    !['quality', 'production'].includes(e.phase) ||
    !Array.isArray(e.reviews) ||
    (!e.waivers?.humanReview && e.reviews.length < 100)
  )
    throw new Error(
      'At least 100 human-reviewed matched sources are required.',
    );
  const unique = new Set<string>(),
    speakers = new Set<string>(),
    subjects = new Set<string>();
  let hebrew = false,
    short = false,
    long = false;
  for (const r of e.reviews) {
    if (
      !hash(r.sourceHash) ||
      !hash(r.referenceArtifactHash) ||
      !hash(r.candidateArtifactHash) ||
      !r.reviewer?.trim() ||
      typeof r.accepted !== 'boolean' ||
      !Array.isArray(r.criticalErrors) ||
      !Array.isArray(r.rejectionReasons)
    )
      throw new Error('Incomplete human review evidence.');
    if (unique.has(r.sourceHash))
      throw new Error('Review sources must be distinct.');
    unique.add(r.sourceHash);
    if (!r.accepted || r.criticalErrors.length || r.rejectionReasons.length)
      throw new Error(
        'Candidate failures must be resolved and independently reviewed before approval.',
      );
    hebrew ||= r.fullyHebrew;
    short ||= r.durationSeconds <= 1200;
    long ||= r.durationSeconds >= 3600;
    speakers.add(r.speaker);
    for (const subject of r.subjects) subjects.add(subject);
  }
  if (
    !e.waivers?.humanReview &&
    (!hebrew || !short || !long || speakers.size < 5 || subjects.size < 3)
  )
    throw new Error(
      'Review coverage must include Hebrew, short/long sources, speakers, and subject areas.',
    );
  if (
    !Number.isSafeInteger(e.concurrency) ||
    e.concurrency < 1 ||
    e.concurrency > 10 ||
    !(e.memoryPeakBytes > 0)
  )
    throw new Error('Measured concurrency and memory evidence required.');
  if (e.phase === 'production') {
    for (const size of [100, 500, 1000])
      if (
        !e.cohorts?.some(
          (c) =>
            c.size === size &&
            c.verifiedPublications === size &&
            c.hashesVerified &&
            c.manifest,
        )
      )
        throw new Error(
          'Verified 100, 500, and 1000 note cohort manifests required.',
        );
    const o = e.observation;
    if (
      !e.waivers?.observation24h &&
      (!o ||
        o.hours < 24 ||
        !o.verifiedPublications ||
        !o.referencePerHour ||
        !o.candidatePerHour ||
        !o.recoveryPassed ||
        !o.manifest)
    )
      throw new Error(
        'A complete 24-hour measured observation and recovery manifest is required.',
      );
  }
}
