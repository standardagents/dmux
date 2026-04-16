import path from 'path';
import type {
  DmuxPane,
  DmuxThemeName,
  SidebarProject,
} from '../types.js';
import {
  DEFAULT_DMUX_THEME,
  DMUX_THEME_NAMES,
  isDmuxThemeName,
} from '../theme/themePalette.js';
import { getPaneProjectName, getPaneProjectRoot } from './paneProject.js';

export const SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY = 'projectColorTheme';
export const AUTO_SIDEBAR_PROJECT_COLOR_THEME_VALUE = 'auto';

const AUTO_SIDEBAR_THEME_ORDER: readonly DmuxThemeName[] = [
  DEFAULT_DMUX_THEME,
  ...DMUX_THEME_NAMES.filter((themeName) => themeName !== DEFAULT_DMUX_THEME),
];

function normalizeProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function normalizeProjectColorTheme(colorTheme: unknown): DmuxThemeName | undefined {
  return isDmuxThemeName(colorTheme) ? colorTheme : undefined;
}

function normalizeProjectColorThemeSource(
  colorThemeSource: unknown,
  hasColorTheme: boolean
): SidebarProject['colorThemeSource'] | undefined {
  if (!hasColorTheme) {
    return undefined;
  }

  return colorThemeSource === 'auto' || colorThemeSource === 'manual'
    ? colorThemeSource
    : undefined;
}

function buildProjectEntry(
  projectRoot: string,
  projectName?: string,
  colorTheme?: unknown,
  colorThemeSource?: unknown
): SidebarProject {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  const derivedName = path.basename(normalizedRoot) || 'project';
  const normalizedColorTheme = normalizeProjectColorTheme(colorTheme);
  const normalizedColorThemeSource = normalizeProjectColorThemeSource(
    colorThemeSource,
    Boolean(normalizedColorTheme)
  );

  return {
    projectRoot: normalizedRoot,
    projectName: projectName?.trim() || derivedName,
    ...(normalizedColorTheme ? { colorTheme: normalizedColorTheme } : {}),
    ...(normalizedColorThemeSource ? { colorThemeSource: normalizedColorThemeSource } : {}),
  };
}

export function sameSidebarProjectRoot(a: string, b: string): boolean {
  return normalizeProjectRoot(a) === normalizeProjectRoot(b);
}

export function hasSidebarProject(
  projects: SidebarProject[],
  projectRoot: string
): boolean {
  return projects.some((project) => sameSidebarProjectRoot(project.projectRoot, projectRoot));
}

export function addSidebarProject(
  projects: SidebarProject[],
  project: SidebarProject
): SidebarProject[] {
  if (hasSidebarProject(projects, project.projectRoot)) {
    return projects;
  }

  return [
    ...projects,
    buildProjectEntry(
      project.projectRoot,
      project.projectName,
      project.colorTheme,
      project.colorThemeSource
    ),
  ];
}

export function removeSidebarProject(
  projects: SidebarProject[],
  projectRoot: string
): SidebarProject[] {
  return projects.filter((project) => !sameSidebarProjectRoot(project.projectRoot, projectRoot));
}

export function getSidebarProjectColorTheme(
  projects: SidebarProject[],
  projectRoot: string
): DmuxThemeName | undefined {
  return projects.find((project) => sameSidebarProjectRoot(project.projectRoot, projectRoot))?.colorTheme;
}

function getSidebarProject(
  projects: SidebarProject[],
  projectRoot: string
): SidebarProject | undefined {
  return projects.find((project) => sameSidebarProjectRoot(project.projectRoot, projectRoot));
}

export function setSidebarProjectColorTheme(
  projects: SidebarProject[],
  projectRoot: string,
  colorTheme: DmuxThemeName | undefined,
  colorThemeSource?: SidebarProject['colorThemeSource']
): SidebarProject[] {
  const normalizedColorTheme = normalizeProjectColorTheme(colorTheme);
  const normalizedColorThemeSource = normalizeProjectColorThemeSource(
    colorThemeSource,
    Boolean(normalizedColorTheme)
  );
  let changed = false;

  const nextProjects = projects.map((project) => {
    if (!sameSidebarProjectRoot(project.projectRoot, projectRoot)) {
      return project;
    }

    const nextProject = buildProjectEntry(
      project.projectRoot,
      project.projectName,
      normalizedColorTheme,
      normalizedColorThemeSource
    );
    if (
      project.projectRoot === nextProject.projectRoot
      && project.projectName === nextProject.projectName
      && project.colorTheme === nextProject.colorTheme
      && project.colorThemeSource === nextProject.colorThemeSource
    ) {
      return project;
    }

    changed = true;
    return nextProject;
  });

  return changed ? nextProjects : projects;
}

function getProjectsWithoutProject(
  projects: SidebarProject[],
  projectRoot: string
): SidebarProject[] {
  return projects.filter((project) => !sameSidebarProjectRoot(project.projectRoot, projectRoot));
}

export function getSidebarProjectColorThemeSettingValue(
  projects: SidebarProject[],
  projectRoot: string,
  resolveProjectTheme?: (projectRoot: string) => DmuxThemeName | undefined
): string {
  const project = getSidebarProject(projects, projectRoot);
  if (!project?.colorTheme) {
    return '';
  }

  if (project.colorThemeSource === 'auto') {
    return AUTO_SIDEBAR_PROJECT_COLOR_THEME_VALUE;
  }

  if (project.colorThemeSource === 'manual') {
    return project.colorTheme;
  }

  const inferredAutoTheme = getAutoSidebarProjectColorTheme(
    getProjectsWithoutProject(projects, projectRoot),
    { projectRoot },
    resolveProjectTheme
  );

  return project.colorTheme === inferredAutoTheme
    ? AUTO_SIDEBAR_PROJECT_COLOR_THEME_VALUE
    : project.colorTheme;
}

export function setSidebarProjectColorThemeSettingValue(
  projects: SidebarProject[],
  projectRoot: string,
  settingValue: unknown,
  resolveProjectTheme?: (projectRoot: string) => DmuxThemeName | undefined
): SidebarProject[] {
  if (settingValue === AUTO_SIDEBAR_PROJECT_COLOR_THEME_VALUE) {
    const autoTheme = getAutoSidebarProjectColorTheme(
      getProjectsWithoutProject(projects, projectRoot),
      { projectRoot },
      resolveProjectTheme
    );
    return setSidebarProjectColorTheme(projects, projectRoot, autoTheme, 'auto');
  }

  if (settingValue === '') {
    return setSidebarProjectColorTheme(projects, projectRoot, undefined);
  }

  if (isDmuxThemeName(settingValue)) {
    return setSidebarProjectColorTheme(projects, projectRoot, settingValue, 'manual');
  }

  return projects;
}

export function getAutoSidebarProjectColorTheme(
  projects: SidebarProject[],
  nextProject: Pick<SidebarProject, 'projectRoot' | 'colorTheme'>,
  resolveProjectTheme?: (projectRoot: string) => DmuxThemeName | undefined
): DmuxThemeName {
  const usedThemes = new Set<DmuxThemeName>();

  for (const project of projects) {
    const resolvedTheme = normalizeProjectColorTheme(project.colorTheme)
      || normalizeProjectColorTheme(resolveProjectTheme?.(project.projectRoot));
    if (resolvedTheme) {
      usedThemes.add(resolvedTheme);
    }
  }

  const preferredTheme = normalizeProjectColorTheme(nextProject.colorTheme)
    || normalizeProjectColorTheme(resolveProjectTheme?.(nextProject.projectRoot));
  if (preferredTheme && !usedThemes.has(preferredTheme)) {
    return preferredTheme;
  }

  return AUTO_SIDEBAR_THEME_ORDER.find((themeName) => !usedThemes.has(themeName))
    || preferredTheme
    || DEFAULT_DMUX_THEME;
}

/**
 * Normalize persistent sidebar projects so the session project is always present,
 * explicit sidebar entries keep their order and metadata, and any pane-backed
 * projects are preserved for backward compatibility.
 */
export function normalizeSidebarProjects(
  sidebarProjects: SidebarProject[] | undefined,
  panes: DmuxPane[],
  fallbackProjectRoot: string,
  fallbackProjectName: string
): SidebarProject[] {
  const normalizedProjects: SidebarProject[] = [];
  const projectIndexByRoot = new Map<string, number>();

  const addProject = (
    projectRoot: string,
    projectName?: string,
    colorTheme?: unknown,
    colorThemeSource?: unknown
  ) => {
    const entry = buildProjectEntry(projectRoot, projectName, colorTheme, colorThemeSource);
    const key = normalizeProjectRoot(entry.projectRoot);
    const existingIndex = projectIndexByRoot.get(key);
    if (existingIndex !== undefined) {
      const existing = normalizedProjects[existingIndex];
      const derivedExistingName = path.basename(normalizeProjectRoot(existing.projectRoot)) || 'project';
      const shouldReplaceName = existing.projectName === derivedExistingName;
      const nextColorTheme = entry.colorTheme || existing.colorTheme;
      const nextColorThemeSource = nextColorTheme
        ? (entry.colorThemeSource ?? existing.colorThemeSource)
        : undefined;
      normalizedProjects[existingIndex] = {
        ...existing,
        projectName: shouldReplaceName ? entry.projectName : existing.projectName,
        ...(nextColorTheme ? { colorTheme: nextColorTheme } : {}),
        ...(nextColorThemeSource ? { colorThemeSource: nextColorThemeSource } : {}),
      };
      return;
    }

    projectIndexByRoot.set(key, normalizedProjects.length);
    normalizedProjects.push(entry);
  };

  addProject(fallbackProjectRoot, fallbackProjectName);

  for (const project of sidebarProjects || []) {
    if (!project?.projectRoot) continue;
    addProject(
      project.projectRoot,
      project.projectName,
      project.colorTheme,
      project.colorThemeSource
    );
  }

  for (const pane of panes) {
    const projectRoot = getPaneProjectRoot(pane, fallbackProjectRoot);
    const projectName = getPaneProjectName(pane, fallbackProjectRoot, fallbackProjectName);
    addProject(projectRoot, projectName);
  }

  return normalizedProjects;
}
