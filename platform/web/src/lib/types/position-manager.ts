// How the Position Manager (Mission 3) classifies a candidate against any existing open position
// in the same instrument:
//   NEW_POSITION    — no existing open trade in this instrument at all
//   ADD_TO_POSITION — an existing same-side position, and every add-to-position rule passed
//   HOLD_POSITION   — an existing same-side position, but the improvement bar wasn't met (not a
//                     violation — just not enough new evidence yet to add more)
//   BLOCK_POSITION  — a hard violation: an opposing existing position, the position value cap
//                     would be exceeded, or portfolio risk fails after the add
export type PositionAction = "NEW_POSITION" | "ADD_TO_POSITION" | "HOLD_POSITION" | "BLOCK_POSITION";
