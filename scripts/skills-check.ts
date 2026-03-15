import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import {
  AGENTS_SKILLS_DIR,
  AGENTS_SKILLS_GITIGNORE,
  buildAgentsSkillsGitignore,
  buildClaudeSkillsGitignore,
  CLAUDE_SKILLS_DIR,
  CLAUDE_SKILLS_GITIGNORE,
  listSkillNames,
  listSkillRelativeFiles,
  readFileSafe,
  ROOT_DIR
} from './skills-common'

function isAgentsReadmeFile(file: string): boolean {
  return /^\.agents\/skills\/README(?:\.[a-z0-9-]+)?\.md$/i.test(file)
}

function isClaudeReadmeFile(file: string): boolean {
  return /^\.claude\/skills\/README(?:\.[a-z0-9-]+)?\.md$/i.test(file)
}

function checkGitignore(filePath: string, expected: string, displayPath: string, errors: string[]) {
  const actual = readFileSafe(filePath)
  if (actual === null) {
    errors.push(`${displayPath} is missing`)
    return
  }
  if (actual !== expected) {
    errors.push(`${displayPath} is out of date (run pnpm skills:sync)`)
  }
}

/**
 * Verifies `.claude/skills/<skillName>/` matches `.agents/skills/<skillName>/`.
 * Public skills may contain scripts and templates, so validation compares the full directory.
 */
function checkClaudeSkillDirectory(skillName: string, errors: string[]) {
  const agentsSkillDir = path.join(AGENTS_SKILLS_DIR, skillName)
  const claudeSkillDir = path.join(CLAUDE_SKILLS_DIR, skillName)

  if (!fs.existsSync(claudeSkillDir)) {
    errors.push(`.claude/skills/${skillName} is missing`)
    return
  }

  if (!fs.statSync(claudeSkillDir).isDirectory()) {
    errors.push(`.claude/skills/${skillName} is not a directory`)
    return
  }

  let expectedFiles: string[]
  let actualFiles: string[]
  try {
    expectedFiles = listSkillRelativeFiles(agentsSkillDir)
    actualFiles = listSkillRelativeFiles(claudeSkillDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`failed to inspect public skill '${skillName}': ${message}`)
    return
  }

  const expectedFileSet = new Set(expectedFiles)
  const actualFileSet = new Set(actualFiles)

  for (const relativePath of expectedFiles) {
    if (!actualFileSet.has(relativePath)) {
      errors.push(`.claude/skills/${skillName}/${relativePath} is missing`)
      continue
    }

    const agentsFile = path.join(agentsSkillDir, relativePath)
    const claudeFile = path.join(claudeSkillDir, relativePath)
    const expectedContent = fs.readFileSync(agentsFile)
    const actualContent = fs.readFileSync(claudeFile)

    if (!actualContent.equals(expectedContent)) {
      errors.push(
        `.claude/skills/${skillName}/${relativePath} content differs from .agents/skills/${skillName}/${relativePath}`
      )
    }
  }

  for (const relativePath of actualFiles) {
    if (!expectedFileSet.has(relativePath)) {
      errors.push(`.claude/skills/${skillName}/${relativePath} should not exist (run pnpm skills:sync)`)
    }
  }
}

function checkTrackedFilesAgainstWhitelist(skillNames: string[], errors: string[]) {
  const sharedAgentsFiles = new Set(['.agents/skills/.gitignore', '.agents/skills/public-skills.txt'])
  const sharedClaudeFiles = new Set(['.claude/skills/.gitignore'])
  const allowedAgentsPrefixes = skillNames.map((skillName) => `.agents/skills/${skillName}/`)
  const allowedClaudePrefixes = skillNames.map((skillName) => `.claude/skills/${skillName}/`)

  let trackedFiles: string[]
  try {
    const output = execSync('git ls-files -- .agents/skills .claude/skills', {
      cwd: ROOT_DIR,
      encoding: 'utf-8'
    })
    trackedFiles = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`failed to read tracked skill files via git ls-files: ${message}`)
    return
  }

  for (const file of trackedFiles) {
    if (file.startsWith('.agents/skills/')) {
      if (sharedAgentsFiles.has(file) || isAgentsReadmeFile(file)) {
        continue
      }
      if (allowedAgentsPrefixes.some((prefix) => file.startsWith(prefix))) {
        continue
      }
      errors.push(`tracked file is outside public skill whitelist: ${file}`)
      continue
    }

    if (file.startsWith('.claude/skills/')) {
      if (sharedClaudeFiles.has(file) || isClaudeReadmeFile(file)) {
        continue
      }
      if (allowedClaudePrefixes.some((prefix) => file.startsWith(prefix))) {
        continue
      }
      errors.push(`tracked file is outside public skill whitelist: ${file}`)
    }
  }
}

/**
 * Validates public skills governance:
 * - generated gitignore files are up to date
 * - Claude skill directories match source skill directories by content
 * - tracked skill files do not exceed the public whitelist
 */
function main() {
  let skillNames: string[]
  try {
    skillNames = listSkillNames()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`skills:check failed: ${message}`)
    process.exit(1)
  }

  const errors: string[] = []

  checkGitignore(AGENTS_SKILLS_GITIGNORE, buildAgentsSkillsGitignore(skillNames), '.agents/skills/.gitignore', errors)
  checkGitignore(CLAUDE_SKILLS_GITIGNORE, buildClaudeSkillsGitignore(skillNames), '.claude/skills/.gitignore', errors)

  for (const skillName of skillNames) {
    const agentSkillPath = path.join(AGENTS_SKILLS_DIR, skillName, 'SKILL.md')
    if (!fs.existsSync(agentSkillPath)) {
      errors.push(`.agents/skills/${skillName}/SKILL.md is missing`)
      continue
    }

    checkClaudeSkillDirectory(skillName, errors)
  }
  checkTrackedFilesAgainstWhitelist(skillNames, errors)

  if (errors.length > 0) {
    console.error('skills:check failed')
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exit(1)
  }

  console.log(`skills:check passed (${skillNames.length} public skill${skillNames.length === 1 ? '' : 's'})`)
}

main()
