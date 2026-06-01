import { ipcMain } from 'electron'
import type {
  SkillCreateInput,
  SkillDetail,
  SkillImportFolderInput,
  SkillImportGitInput,
  SkillImportResult,
  SkillInfo,
  SkillRef,
  SkillUpdateInput,
} from '../../shared/types'
import {
  createSkill,
  deleteSkill,
  importFolder,
  importGit,
  listSkills,
  readSkill,
  updateSkill,
} from '../services/skills'

// Couche IPC mince : déléguer au service skills (cf. services/skills.ts). Une exception levée dans un handler
// est propagée au renderer (rejet de la promesse invoke) → l'UI affiche le message d'erreur.
export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', (_e, projectPath?: string | null): SkillInfo[] => listSkills(projectPath))
  ipcMain.handle('skills:read', (_e, ref: SkillRef): SkillDetail => readSkill(ref))
  ipcMain.handle('skills:create', (_e, input: SkillCreateInput): SkillInfo => createSkill(input))
  ipcMain.handle('skills:importFolder', (_e, input: SkillImportFolderInput): SkillImportResult => importFolder(input))
  ipcMain.handle('skills:importGit', (_e, input: SkillImportGitInput): Promise<SkillImportResult> => importGit(input))
  ipcMain.handle('skills:update', (_e, input: SkillUpdateInput): SkillInfo => updateSkill(input))
  ipcMain.handle('skills:delete', (_e, ref: SkillRef): void => deleteSkill(ref))
}
