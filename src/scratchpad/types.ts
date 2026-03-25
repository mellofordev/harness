/**
 * Scratchpad Type Definitions
 *
 * Types for the file-based scratchpad communication layer.
 * Scratchpads replace heavy message payloads with persistent markdown files
 * that agents write to and read from on-demand.
 */

/** Standardized sections within a scratchpad markdown file */
export type ScratchpadSection =
  | "status"
  | "findings"
  | "files_changed"
  | "lessons"
  | "blockers"
  | "decisions";

/** All valid section names for iteration/validation */
export const SCRATCHPAD_SECTIONS: ScratchpadSection[] = [
  "status",
  "findings",
  "files_changed",
  "lessons",
  "blockers",
  "decisions",
];

/** Map from section type to markdown heading */
export const SECTION_HEADINGS: Record<ScratchpadSection, string> = {
  status: "Status",
  findings: "Findings",
  files_changed: "Files Changed",
  lessons: "Lessons",
  blockers: "Blockers",
  decisions: "Decisions",
};

/**
 * Lightweight reference to an agent's scratchpad.
 * Sent in messages instead of full TaskResult objects.
 */
export interface ScratchpadRef {
  agentId: string;
  scratchpadPath: string;
  sections?: ScratchpadSection[];
  lastUpdated: number;
}

/** ID for the shared project scratchpad */
export const PROJECT_PAD_ID = "_project";
