// /lib/risk-colors.js
// ---------------------------------------------------------------
// Single-source logic for all risk-tier color decisions in Vision
// Used by: graph.js, app.js, ScoreMeter.js, Narrative Engine, etc.
// ---------------------------------------------------------------

export function colorForScore(score = 0, blocked = false) {
  // Hard red for any OFAC or explicit block
  if (blocked) return '#ef4444';

  // Same colors used by node halos in v1.4 and v1.5
  if (score >= 80) return '#ff3b3b';    // High red
  if (score >= 60) return '#ffb020';    // Elevated orange
  if (score >= 40) return '#ffc857';    // Moderate yellow
  if (score >= 20) return '#22d37b';    // Low green
  return '#00eec3';                     // Very low teal
}

export function bandForScore(score = 0, blocked = false) {
  // These band labels feed ScoreMeter + narrative consistency
  if (blocked) return 'High';           // Matches OFAC → High
  if (score >= 80) return 'High';
  if (score >= 60) return 'Elevated';
  if (score >= 40) return 'Moderate';
  if (score >= 20) return 'Low';
  return 'Very low';
}
