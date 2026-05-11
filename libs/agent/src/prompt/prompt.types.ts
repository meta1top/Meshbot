export interface PromptEntry {
  content: string;
  mtime: number;
}

export type PromptMap = Map<string, PromptEntry>;
