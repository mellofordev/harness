# Simple Demo Plan

A simple two-task plan to demonstrate basic orchestration.

Workers: claude-code

## Task 1: List project files [normal]
List all TypeScript files in the project and provide a brief summary of each.
Files: src/**/*.ts

## Task 2: Summarize findings [low]
Based on the file listing, write a brief project overview.
Files: PROJECT_SUMMARY.md
Depends on: 1
