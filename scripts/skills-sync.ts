import * as fs from 'fs'
import * as path from 'path'

import { AGENTS_SKILLS_DIR, CLAUDE_SKILLS_DIR } from './skills-common'
import {
  AGENTS_SKILLS_GITIGNORE,
  buildAgentsSkillsGitignore,
  buildClaudeSkillsGitignore,
  CLAUDE_SKILLS_GITIGNORE,
  listSkillNames,
  listSkillRelativeFiles,
  writeFileIfChanged
} from './skills-common'

/**
 * Ensures `.claude/skills/<skillName>/` mirrors `.agents/skills/<skillName>/`.
 * Public skills can include scripts and templates, so the full directory is synced.
 */
function ensureClaudeSkillDirectory(skillName: string): string[] {
  const agentsSkillDir = path.join(AGENTS_SKILLS_DIR, skillName)
  const claudeSkillDir = path.join(CLAUDE_SKILLS_DIR, skillName)
  const agentsSkillFile = path.join(agentsSkillDir, 'SKILL.md')

  if (!fs.existsSync(agentsSkillFile)) {
    throw new Error(`.agents/skills/${skillName}/SKILL.md is missing`)
  }

  fs.mkdirSync(claudeSkillDir, { recursive: true })

  const changedFiles: string[] = []
  const expectedFiles = listSkillRelativeFiles(agentsSkillDir)
  const expectedFileSet = new Set(expectedFiles)

  for (const relativePath of expectedFiles) {
    const sourceFile = path.join(agentsSkillDir, relativePath)
    const targetFile = path.join(claudeSkillDir, relativePath)

    fs.mkdirSync(path.dirname(targetFile), { recursive: true })

    const expectedContent = fs.readFileSync(sourceFile)

    let shouldWrite = true
    try {
      const existing = fs.lstatSync(targetFile)
      if (!existing.isFile()) {
        fs.rmSync(targetFile, { recursive: true, force: true })
      } else {
        const currentContent = fs.readFileSync(targetFile)
        shouldWrite = !currentContent.equals(expectedContent)
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code !== 'ENOENT') {
        throw error
      }
    }

    if (shouldWrite) {
      fs.writeFileSync(targetFile, expectedContent)
      changedFiles.push(`.claude/skills/${skillName}/${relativePath}`)
    }
  }

  const actualFiles = listSkillRelativeFiles(claudeSkillDir)
  for (const relativePath of actualFiles) {
    if (expectedFileSet.has(relativePath)) {
      continue
    }

    fs.rmSync(path.join(claudeSkillDir, relativePath), { force: true })
    changedFiles.push(`.claude/skills/${skillName}/${relativePath}`)
  }

  pruneEmptyDirectories(claudeSkillDir)

  return changedFiles
}

function pruneEmptyDirectories(rootDir: string) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    const absolutePath = path.join(rootDir, entry.name)
    pruneEmptyDirectories(absolutePath)
    if (fs.readdirSync(absolutePath).length === 0) {
      fs.rmdirSync(absolutePath)
    }
  }
}

/**
 * Synchronizes skill infrastructure for all public skills:
 * - regenerates whitelist gitignore files
 * - syncs Claude-side skill directories
 */
function main() {
  let skillNames: string[]
  try {
    skillNames = listSkillNames()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`skills:sync failed: ${message}`)
    process.exit(1)
  }

  const agentsGitignore = buildAgentsSkillsGitignore(skillNames)
  const claudeGitignore = buildClaudeSkillsGitignore(skillNames)

  const changedFiles: string[] = []
  const changedSkillFiles: string[] = []

  if (writeFileIfChanged(AGENTS_SKILLS_GITIGNORE, agentsGitignore)) {
    changedFiles.push('.agents/skills/.gitignore')
  }
  if (writeFileIfChanged(CLAUDE_SKILLS_GITIGNORE, claudeGitignore)) {
    changedFiles.push('.claude/skills/.gitignore')
  }
  for (const skillName of skillNames) {
    changedSkillFiles.push(...ensureClaudeSkillDirectory(skillName))
  }

  if (changedFiles.length === 0 && changedSkillFiles.length === 0) {
    console.log(`skills:sync up-to-date (${skillNames.length} public skill${skillNames.length === 1 ? '' : 's'})`)
    return
  }

  const updatedCount = changedFiles.length + changedSkillFiles.length
  console.log(`skills:sync updated ${updatedCount} file${updatedCount === 1 ? '' : 's'}:`)
  for (const file of changedFiles) {
    console.log(`- ${file}`)
  }
  for (const file of changedSkillFiles) {
    console.log(`- ${file}`)
  }
}

main()
