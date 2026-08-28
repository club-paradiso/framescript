import type {
  CharacterEntity,
  EvidenceEvent,
  FusionConflict,
  ProjectCoverage,
  ReconstructedScene,
} from '@/core';

export interface LoadedSource {
  id: string;
  name: string;
  kind: 'subtitle' | 'project' | 'media';
  detail: string;
  language?: string;
  cueCount?: number;
  warnings: string[];
}

export interface StudioIssue {
  id: string;
  severity: 'warning' | 'error';
  message: string;
}

export interface StudioProject {
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  languages: string[];
  coverage: ProjectCoverage;
  conflicts: FusionConflict[];
  evidence: EvidenceEvent[];
  title?: string;
  durationMs?: number;
}
