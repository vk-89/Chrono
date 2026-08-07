// generate-insights.mjs
//
// Run nightly by GitHub Actions (see .github/workflows/nightly-insights.yml).
// Runs three passes over Chrono's Firestore data:
//   1. Read every user's events from the last LOOKBACK_DAYS, compute per-user
//      averages (wake time, time spent per category).
//   2. Bucket users into simple rule-based "cohorts" (this is NOT machine
//      learning clustering — it's transparent if/else bucketing. Good enough
//      for v1; swap in real clustering later once you have real ML experience
//      and a meaningful number of users).
//   3. For any cohort with >= K_ANON_THRESHOLD members, write an aggregated,
//      anonymized stats doc to cohort_stats/{cohortKey}. Cohorts below the
//      threshold are silently skipped — no partial/small-group data ever
//      leaves a user's own document tree.
//
// Then, per user, build a prompt from their OWN stats (+ their cohort's
// aggregate, if one qualified) and ask Gemini to narrate it. Only the
// resulting text is written back, to users/{uid}/insights/latest.
//
// Nothing here ever writes one user's raw events anywhere another user
// could read them. Firestore rules (firestore.rules) enforce this from the
// client side too, as defense in depth.

import admin from 'firebase-admin';

const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const K_ANON_THRESHOLD = parseInt(process.env.K_ANON_THRESHOLD || '20', 10);
const LOOKBACK_DAYS = 30;
const MIN_DAYS_TO_QUALIFY = 5; // don't bother generating insights off <5 logged days
const DAY_START_HOUR = 4;      // must match DAY_START_HOUR in index.html

admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) });
const db = admin.firestore();

/* ---------------- date/time helpers (mirrors index.html's logic) ---------------- */

function pad(n) { return String(n).padStart(2, '0'); }

function isoDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function average(arr) {
  const clean = arr.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function fmtMinutesAsClock(mins) {
  if (mins == null) return 'unknown';
  const total = ((DAY_START_HOUR * 60 + mins) % (24 * 60) + 24 * 60) % (24 * 60);
  let h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + pad(m) + ' ' + ap;
}

function fmtDuration(mins) {
  if (mins == null) return 'no data';
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? (h + 'h ' + m + 'm') : (m + 'm');
}

/* ---------------- step 1: fetch + per-user summaries ---------------- */

async function fetchRecentEventsByUser() {
  const cutoff = isoDateNDaysAgo(LOOKBACK_DAYS);
  // NOTE: this collectionGroup query needs a Firestore index the first time
  // you run it. If it fails with "The query requires an index", the error
  // message includes a direct link to auto-create it — click it, wait ~1
  // minute for the index to build, then re-run the workflow.
  const snap = await db.collectionGroup('events').where('date', '>=', cutoff).get();
  const byUser = new Map();
  snap.forEach((doc) => {
    const uid = doc.ref.parent.parent.id;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(doc.data());
  });
  return byUser;
}

// Rebuilds per-day category totals + wake time from raw point-in-time events,
// the same way the app's own timeline does it: each event runs until the
// next one starts. Simplification: the very last event in a user's whole
// history is assumed to run 30 minutes (we don't know when/if it ended).
function buildDailyStats(events) {
  events.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const dayMap = new Map(); // date -> {study,social,essential,firstTime}

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const start = new Date(ev.start_time);
    const date = ev.date;
    if (!date) continue;
    if (!dayMap.has(date)) {
      dayMap.set(date, { study: 0, social: 0, essential: 0, firstTime: start });
    }
    const rec = dayMap.get(date);
    if (start < rec.firstTime) rec.firstTime = start;
    if (ev.instant) continue; // instant markers have no duration

    let end;
    if (i < events.length - 1) {
      end = new Date(events[i + 1].start_time);
    } else {
      end = new Date(start.getTime() + 30 * 60000);
    }
    const mins = Math.max(0, (end - start) / 60000);
    if (rec[ev.category] !== undefined) rec[ev.category] += mins;
  }

  dayMap.forEach((rec, date) => {
    const dayStart = new Date(date + 'T00:00:00');
    dayStart.setHours(dayStart.getHours() + DAY_START_HOUR);
    rec.wakeMinutes = (rec.firstTime - dayStart) / 60000;
  });

  return dayMap;
}

function summarizeUser(dayMap) {
  const days = Array.from(dayMap.values());
  const wakeArr = days.map((d) => d.wakeMinutes).filter((v) => v >= 0 && v < 24 * 60);
  return {
    daysLogged: days.length,
    avgWakeMinutes: average(wakeArr),
    avgStudyMinutes: average(days.map((d) => d.study)),
    avgSocialMinutes: average(days.map((d) => d.social)),
    avgEssentialMinutes: average(days.map((d) => d.essential)),
  };
}

/* ---------------- step 2: rule-based cohort bucketing ---------------- */

function wakeBucket(avgWakeMinutes) {
  if (avgWakeMinutes == null) return 'unknownwake';
  const hoursAfterDayStart = avgWakeMinutes / 60; // hours after 4AM
  if (hoursAfterDayStart < 3) return 'early';   // before ~7AM
  if (hoursAfterDayStart < 6) return 'mid';     // ~7AM - 10AM
  return 'late';                                 // after ~10AM
}

function studyBucket(avgStudyMinutes) {
  if (avgStudyMinutes == null) return 'q0';
  if (avgStudyMinutes < 60) return 'q1';
  if (avgStudyMinutes < 150) return 'q2';
  if (avgStudyMinutes < 300) return 'q3';
  return 'q4';
}

function cohortKeyFor(summary) {
  return wakeBucket(summary.avgWakeMinutes) + '_' + studyBucket(summary.avgStudyMinutes);
}

/* ---------------- step 3: Gemini narration ---------------- */

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return text.trim();
}

function buildPrompt(summary, cohortSummary) {
  let p =
    'You are a calm, encouraging routine coach. Based on this person\'s own logged ' +
    'activity data, write 3 to 5 short, specific observations about their daily ' +
    'routine patterns, then 1 to 2 gentle, practical suggestions. Plain text, no ' +
    'headers or markdown, under 150 words total.\n\n' +
    `Their data (last ${summary.daysLogged} logged days):\n` +
    `- Average wake-up time: ${fmtMinutesAsClock(summary.avgWakeMinutes)}\n` +
    `- Average Study time/day: ${fmtDuration(summary.avgStudyMinutes)}\n` +
    `- Average Social/Fun time/day: ${fmtDuration(summary.avgSocialMinutes)}\n` +
    `- Average Essential time/day (meals, commute, rest, sleep, etc.): ${fmtDuration(summary.avgEssentialMinutes)}\n`;

  if (cohortSummary) {
    p +=
      `\nFor light context, among ${cohortSummary.memberCount} other users with a broadly ` +
      'similar routine shape (already anonymized and aggregated — do not refer to this ' +
      'as "other users\' data" in your reply, just use it as quiet context if it\'s useful):\n' +
      `- Their average wake-up time: ${fmtMinutesAsClock(cohortSummary.avgWakeMinutes)}\n` +
      `- Their average Study time/day: ${fmtDuration(cohortSummary.avgStudyMinutes)}\n`;
  }
  return p;
}

/* ---------------- main ---------------- */

async function main() {
  console.log(`Fetching events from the last ${LOOKBACK_DAYS} days...`);
  const byUser = await fetchRecentEventsByUser();
  console.log(`Found event data for ${byUser.size} users`);

  const userSummaries = new Map();
  const cohortCandidates = new Map();

  byUser.forEach((events, uid) => {
    const dayMap = buildDailyStats(events);
    const summary = summarizeUser(dayMap);
    if (summary.daysLogged < MIN_DAYS_TO_QUALIFY) return;
    userSummaries.set(uid, summary);
    const key = cohortKeyFor(summary);
    if (!cohortCandidates.has(key)) cohortCandidates.set(key, []);
    cohortCandidates.get(key).push(summary);
  });

  console.log(
    `${userSummaries.size} users have enough data (>=${MIN_DAYS_TO_QUALIFY} days); ` +
    `${cohortCandidates.size} candidate cohorts formed`
  );

  const qualifiedCohorts = new Map();
  for (const [key, members] of cohortCandidates.entries()) {
    if (members.length < K_ANON_THRESHOLD) {
      console.log(`  cohort "${key}": ${members.length} members — below threshold (${K_ANON_THRESHOLD}), skipped`);
      continue;
    }
    const agg = {
      memberCount: members.length,
      avgWakeMinutes: average(members.map((m) => m.avgWakeMinutes)),
      avgStudyMinutes: average(members.map((m) => m.avgStudyMinutes)),
      avgSocialMinutes: average(members.map((m) => m.avgSocialMinutes)),
      avgEssentialMinutes: average(members.map((m) => m.avgEssentialMinutes)),
      updated_at: new Date().toISOString(),
    };
    qualifiedCohorts.set(key, agg);
    await db.collection('cohort_stats').doc(key).set(agg);
    console.log(`  cohort "${key}": ${members.length} members — written to cohort_stats/${key}`);
  }

  let done = 0;
  for (const [uid, summary] of userSummaries.entries()) {
    const key = cohortKeyFor(summary);
    const cohortSummary = qualifiedCohorts.get(key) || null;
    const prompt = buildPrompt(summary, cohortSummary);
    try {
      const text = await callGemini(prompt);
      await db.collection('users').doc(uid).collection('insights').doc('latest').set({
        text,
        generated_at: new Date().toISOString(),
        stats: summary,
        cohort_key: key,
        cohort_available: !!cohortSummary,
      });
      console.log(`  wrote insight for user ${uid}`);
    } catch (err) {
      console.error(`  FAILED for user ${uid}:`, err.message);
    }
    done++;
    await sleep(7000); // stay comfortably under Gemini free-tier rate limits
  }

  console.log(`Done. Generated insights for ${done} users.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
