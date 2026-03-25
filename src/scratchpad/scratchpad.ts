/**
 * Scratchpad Manager
 *
 * Manages persistent markdown scratchpad files for inter-agent communication.
 * Each agent gets its own scratchpad, plus a shared project scratchpad.
 *
 * Scratchpads replace heavy message payloads: instead of sending full TaskResult
 * objects through the message bus, agents write structured findings to their
 * scratchpad and downstream agents read only the sections they need.
 *
 * Directory structure:
 *   .harness/scratchpads/
 *   ├── _project.md          # Shared project-level context
 *   └── {agentId}.md         # Per-agent scratchpad
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ScratchpadSection,
  type ScratchpadRef,
  SECTION_HEADINGS,
  SCRATCHPAD_SECTIONS,
  PROJECT_PAD_ID,
} from "./types";
import { logger } from "../utils/logger";

export class ScratchpadManager {
  private scratchpadDir: string;

  constructor(baseDir: string) {
    this.scratchpadDir = join(baseDir, "scratchpads");
  }

  // ─── Initialization ──────────────────────────────────────────

  initialize(): void {
    if (!existsSync(this.scratchpadDir)) {
      mkdirSync(this.scratchpadDir, { recursive: true });
    }
    // Initialize project scratchpad if it doesn't exist
    this.initPad(PROJECT_PAD_ID, "Project Scratchpad");
    logger.debug("Scratchpad manager initialized", { dir: this.scratchpadDir });
  }

  /** Create a scratchpad file for an agent with empty sections */
  initAgent(agentId: string): string {
    return this.initPad(agentId, `Agent Scratchpad: ${agentId}`);
  }

  private initPad(id: string, title: string): string {
    const filePath = this.getPadPath(id);
    if (existsSync(filePath)) return filePath;

    const lines: string[] = [
      `# ${title}`,
      `> Last updated: ${new Date().toISOString()}`,
      "",
    ];

    for (const section of SCRATCHPAD_SECTIONS) {
      lines.push(`## ${SECTION_HEADINGS[section]}`);
      lines.push("(none)");
      lines.push("");
    }

    writeFileSync(filePath, lines.join("\n"));
    return filePath;
  }

  // ─── Write Operations ────────────────────────────────────────

  /** Append an entry to a section in an agent's scratchpad */
  appendSection(agentId: string, section: ScratchpadSection, content: string, taskId?: string): void {
    this.ensurePad(agentId);
    const filePath = this.getPadPath(agentId);
    const raw = readFileSync(filePath, "utf-8");
    const sections = this.parseSections(raw);

    const entry = taskId ? `- [${taskId}] ${content}` : `- ${content}`;

    // Replace "(none)" placeholder or append
    if (sections[section].length === 1 && sections[section][0] === "(none)") {
      sections[section] = [entry];
    } else {
      sections[section].push(entry);
    }

    this.writePad(agentId, sections, raw);
  }

  /** Replace all content in a section */
  replaceSection(agentId: string, section: ScratchpadSection, content: string): void {
    this.ensurePad(agentId);
    const filePath = this.getPadPath(agentId);
    const raw = readFileSync(filePath, "utf-8");
    const sections = this.parseSections(raw);

    sections[section] = content.trim() ? content.trim().split("\n") : ["(none)"];

    this.writePad(agentId, sections, raw);
  }

  /** Append to the shared project scratchpad */
  updateProjectPad(section: ScratchpadSection, content: string, agentId?: string): void {
    const prefix = agentId ? `[${agentId}]` : "";
    const entry = `- ${prefix} ${content}`.trim();
    this.appendSection(PROJECT_PAD_ID, section, content.startsWith("- ") ? content.slice(2) : content);
  }

  // ─── Read Operations ─────────────────────────────────────────

  /** Read the raw markdown content of a scratchpad */
  readPad(agentId: string): string | null {
    const filePath = this.getPadPath(agentId);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }

  /** Read entries from a specific section */
  readSection(agentId: string, section: ScratchpadSection): string[] {
    const raw = this.readPad(agentId);
    if (!raw) return [];
    const sections = this.parseSections(raw);
    const entries = sections[section];
    // Filter out "(none)" placeholder
    return entries.filter((e) => e !== "(none)");
  }

  /** Read the shared project scratchpad */
  readProjectPad(): string | null {
    return this.readPad(PROJECT_PAD_ID);
  }

  /** Get a lightweight reference to an agent's scratchpad */
  getRef(agentId: string): ScratchpadRef | null {
    const filePath = this.getPadPath(agentId);
    if (!existsSync(filePath)) return null;

    const stat = statSync(filePath);
    return {
      agentId,
      scratchpadPath: filePath,
      lastUpdated: stat.mtimeMs,
    };
  }

  /** Get the file path of the project scratchpad */
  getProjectPadPath(): string {
    return this.getPadPath(PROJECT_PAD_ID);
  }

  // ─── Context Building ────────────────────────────────────────

  /**
   * Build a formatted prompt context string from scratchpad references.
   * Reads only status, findings, and files_changed sections — the most
   * relevant for downstream agents.
   */
  buildPromptContext(refs: ScratchpadRef[]): string {
    const lines: string[] = [];

    for (const ref of refs) {
      const raw = this.readPad(ref.agentId);
      if (!raw) continue;

      const sections = this.parseSections(raw);
      const relevantSections: ScratchpadSection[] = ref.sections || [
        "status",
        "findings",
        "files_changed",
      ];

      lines.push(`### From ${ref.agentId}:`);
      for (const section of relevantSections) {
        const entries = sections[section].filter((e) => e !== "(none)");
        if (entries.length > 0) {
          lines.push(`**${SECTION_HEADINGS[section]}:**`);
          lines.push(...entries);
        }
      }
      lines.push("");
    }

    // Also include relevant project scratchpad context
    const projectRaw = this.readPad(PROJECT_PAD_ID);
    if (projectRaw) {
      const projectSections = this.parseSections(projectRaw);
      const statusEntries = projectSections.status.filter((e) => e !== "(none)");
      const decisionEntries = projectSections.decisions.filter((e) => e !== "(none)");

      if (statusEntries.length > 0 || decisionEntries.length > 0) {
        lines.push("### Project Context:");
        if (statusEntries.length > 0) {
          lines.push("**Status:**");
          lines.push(...statusEntries);
        }
        if (decisionEntries.length > 0) {
          lines.push("**Decisions:**");
          lines.push(...decisionEntries);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  // ─── Cleanup ─────────────────────────────────────────────────

  /** Remove an agent's scratchpad */
  clearAgent(agentId: string): void {
    const filePath = this.getPadPath(agentId);
    if (existsSync(filePath)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(filePath);
    }
  }

  /**
   * Trim a scratchpad to keep only the most recent entries per section.
   * Prevents unbounded growth during long-running plans.
   */
  trimPad(agentId: string, maxEntriesPerSection: number = 20): void {
    const filePath = this.getPadPath(agentId);
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, "utf-8");
    const sections = this.parseSections(raw);

    for (const section of SCRATCHPAD_SECTIONS) {
      const entries = sections[section];
      if (entries.length > maxEntriesPerSection) {
        sections[section] = entries.slice(-maxEntriesPerSection);
      }
    }

    this.writePad(agentId, sections, raw);
  }

  // ─── Internal Helpers ────────────────────────────────────────

  private getPadPath(id: string): string {
    return join(this.scratchpadDir, `${id}.md`);
  }

  private ensurePad(agentId: string): void {
    const filePath = this.getPadPath(agentId);
    if (!existsSync(filePath)) {
      if (agentId === PROJECT_PAD_ID) {
        this.initPad(PROJECT_PAD_ID, "Project Scratchpad");
      } else {
        this.initAgent(agentId);
      }
    }
  }

  /**
   * Parse a scratchpad markdown file into sections.
   * Splits on `## ` headings and collects lines under each.
   */
  private parseSections(raw: string): Record<ScratchpadSection, string[]> {
    const result: Record<ScratchpadSection, string[]> = {
      status: [],
      findings: [],
      files_changed: [],
      lessons: [],
      blockers: [],
      decisions: [],
    };

    // Build a reverse map from heading text to section key
    const headingToSection: Record<string, ScratchpadSection> = {};
    for (const [key, heading] of Object.entries(SECTION_HEADINGS)) {
      headingToSection[heading.toLowerCase()] = key as ScratchpadSection;
    }

    let currentSection: ScratchpadSection | null = null;
    const lines = raw.split("\n");

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const heading = line.slice(3).trim().toLowerCase();
        currentSection = headingToSection[heading] || null;
        continue;
      }

      if (currentSection && line.trim()) {
        result[currentSection].push(line);
      }
    }

    // Ensure sections have at least "(none)" if empty
    for (const section of SCRATCHPAD_SECTIONS) {
      if (result[section].length === 0) {
        result[section] = ["(none)"];
      }
    }

    return result;
  }

  /** Write sections back to a scratchpad file, preserving the header */
  private writePad(
    agentId: string,
    sections: Record<ScratchpadSection, string[]>,
    _originalRaw: string
  ): void {
    const filePath = this.getPadPath(agentId);
    const title =
      agentId === PROJECT_PAD_ID
        ? "Project Scratchpad"
        : `Agent Scratchpad: ${agentId}`;

    const lines: string[] = [
      `# ${title}`,
      `> Last updated: ${new Date().toISOString()}`,
      "",
    ];

    for (const section of SCRATCHPAD_SECTIONS) {
      lines.push(`## ${SECTION_HEADINGS[section]}`);
      const entries = sections[section];
      if (entries.length === 0) {
        lines.push("(none)");
      } else {
        lines.push(...entries);
      }
      lines.push("");
    }

    writeFileSync(filePath, lines.join("\n"));
  }
}
