// Positioning & the competitor map. Conservative and factual: each alternative is described by what it
// is widely known to do; anything we could not verify from a public source in this session is marked
// `verified: false` and worded as "as far as we know". Seen's gap and category follow April Dunford's
// order — competitive alternatives → unique attributes → value → who cares most → market category.
import { rule } from './rules.mjs';

export const COMPETITORS = [
  { id: 'glassdoor', name: 'Glassdoor', kind: 'Employer review site',
    doesWell: ['Huge library of employee reviews, salaries and interview-experience write-ups', 'Ranks for almost every "<company> reviews" search'],
    gap: 'Reviews mostly describe working there or a completed interview. Whether an employer answers applicants at all is not a first-class number there, as far as we know.',
    seenAngle: 'Glassdoor tells you what it is like inside. Seen tells you whether they will answer you at the door.',
    verified: false, note: 'Owner decision 2026-10-20: Seen never imports Glassdoor or Indeed review pages.' },
  { id: 'indeed', name: 'Indeed (company reviews)', kind: 'Job board with company pages',
    doesWell: ['The default place many people apply', 'Company pages with ratings, reviews and Q&A'],
    gap: 'Its incentive is more applications; a public per-employer response or ghost rate is not something it publishes, as far as we know.',
    seenAngle: 'Indeed helps you apply to more jobs. Seen helps you apply to the ones that answer.', verified: false },
  { id: 'blind', name: 'Blind', kind: 'Anonymous verified-employee community',
    doesWell: ['Candid talk among employees verified by work email', 'Strong in big tech'],
    gap: 'Built for people who already work somewhere; job seekers outside those companies, and hourly or agency roles, are mostly not its audience.',
    seenAngle: 'Blind is for insiders. Seen is for the people still trying to get a reply.', verified: false },
  { id: 'fishbowl', name: 'Fishbowl', kind: 'Professional community (from Glassdoor)',
    doesWell: ['Industry "bowls" for professional conversation'],
    gap: 'Conversation, not a structured record of hiring outcomes.',
    seenAngle: 'Conversation fades; a response record keeps counting.', verified: false },
  { id: 'linkedin', name: 'LinkedIn', kind: 'Professional network + job board',
    doesWell: ['Where recruiters and professionals are', 'Easy Apply and company pages'],
    gap: 'Shows who is hiring, not whether they answer applicants; a public per-company ghosting record is not something it publishes, as far as we know.',
    seenAngle: 'LinkedIn shows the job. Seen shows what happened to the people who applied.', verified: false },
  { id: 'trackers', name: 'Teal / Huntr / Simplify', kind: 'Personal job-search trackers and autofill tools',
    doesWell: ['Organise your own applications', 'Résumé tools and autofill that save time'],
    gap: 'They track YOUR search; as far as we know none publishes an aggregate, per-employer response record built from everyone\'s outcomes.',
    seenAngle: 'Seen is a tracker too — and every outcome you track warns the next applicant.', verified: false },
  { id: 'recruitinghell', name: 'r/recruitinghell', kind: 'Community (Reddit)',
    doesWell: ['A huge, honest place to vent and be believed', 'Real stories, fast'],
    gap: 'Stories are scattered threads: not searchable by employer, not counted, gone from the front page in a day.',
    seenAngle: 'Not a competitor — the beachhead. Seen turns the stories people already tell into a record the next person can check.',
    verified: true, note: 'Treat as home turf: value first, follow its rules.' },
];

export const CATEGORY = {
  name: 'The public response record of employers',
  short: 'Employer response record',
  oneLiner: 'Seen is the public record of which employers and staffing agencies actually answer applicants.',
  whyNow: 'Applicants talk about being ghosted constantly, but no common place counts it by employer — the stories exist, the record does not.',
};

export const UNIQUE_ATTRIBUTES = [
  { attr: 'Outcome truth', detail: 'Ghost and response rates per employer from applicant-reported outcomes, trust-weighted, with the sample size shown.' },
  { attr: 'The Staffing Agency Ghost Index', detail: 'A living ranking of major agencies at seenjobs.io/agencies — the most-ghosted segment, tracked by name.' },
  { attr: 'Honest confidence', detail: 'A grade only with ≥5 first-party reports; "not enough data" otherwise. Small samples are labelled, never inflated.' },
  { attr: 'Tracker that feeds the record', detail: 'One-tap day 7/14/30 check-ins turn a personal search into data that warns the next applicant.' },
  { attr: 'Unbuyable scores', detail: 'Money never changes a score.' },
];

/** The positioning canvas (Dunford order) + the map. */
export function positioning() {
  return {
    rule: rule('positioning'),
    alternatives: COMPETITORS,
    uniqueAttributes: UNIQUE_ATTRIBUTES,
    value: 'Save the weeks you would spend waiting on employers that never answer; spend your applications where people reply.',
    bestFit: 'People who have been ghosted by a staffing agency or a big hourly employer and are applying again this week.',
    category: CATEGORY,
    standApart: [
      'Every competitor measures the job or the workplace; Seen measures the response. Say "response record", not "reviews".',
      'Lead with the agency index — nobody else ranks staffing agencies by applicant outcomes, as far as we know.',
      'Show small numbers honestly; the competitors\' scale is a reason to be precise, not to pretend.',
    ],
    unverifiedNote: 'Competitor descriptions marked verified:false are our reading of public products, not checked this session — re-check before quoting any of them in public copy.',
  };
}
