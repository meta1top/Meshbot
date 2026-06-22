import type { MarketSkillSummary } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { findSkillRoot } from "../skill-archive";
import type { SkillPackage, SkillSourceAdapter } from "./skill-source";

/**
 * 解析 `owner/repo[@ref]` 格式的 GitHub 技能 ref。
 * - `owner/repo` → { owner, repo, ref: "HEAD" }
 * - `owner/repo@main` → { owner, repo, ref: "main" }
 * - `owner/repo@v1.0.0` → { owner, repo, ref: "v1.0.0" }
 */
function parseGithubRef(raw: string): {
  owner: string;
  repo: string;
  ref: string;
} {
  const atIdx = raw.lastIndexOf("@");
  const slashPart = atIdx === -1 ? raw : raw.slice(0, atIdx);
  const ref = atIdx === -1 ? "HEAD" : raw.slice(atIdx + 1);

  const slashIdx = slashPart.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid GitHub ref "${raw}": expected "owner/repo[@ref]"`);
  }
  const owner = slashPart.slice(0, slashIdx);
  const repo = slashPart.slice(slashIdx + 1);
  return { owner, repo, ref };
}

/**
 * GitHub 来源适配器。
 * - fetchPackage：通过 codeload.github.com 下载 tar.gz，findSkillRoot 定位技能根。
 * - list：GitHub 无预检索端点，返回 []。
 */
@Injectable()
export class GithubSource implements SkillSourceAdapter {
  /** GitHub 不支持列表检索，始终返回空数组。 */
  async list(_q?: string): Promise<MarketSkillSummary[]> {
    return [];
  }

  /**
   * 下载 GitHub 仓库 tar.gz 并推断技能目录名。
   *
   * GitHub 的 codeload tar 顶层目录格式为 `<repo>-<ref>/`，技能内容通常在
   * 该子目录下（GitHub Actions / template 仓库）。findSkillRoot 负责定位含
   * SKILL.md 的子目录，suggestedName 优先取 findSkillRoot 结果，退而取 repo 名。
   */
  async fetchPackage(rawRef: string, _version?: string): Promise<SkillPackage> {
    const { owner, repo, ref } = parseGithubRef(rawRef);
    const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `GitHub codeload 下载失败 (${res.status}): ${owner}/${repo}@${ref}`,
      );
    }

    const arrayBuf = await res.arrayBuffer();
    const tarGz = Buffer.from(arrayBuf);

    // 找含 SKILL.md 的目录名（可能是 "." 或 "<repo>-<ref>" 或子目录）
    const skillRoot = await findSkillRoot(tarGz);
    const suggestedName = skillRoot && skillRoot !== "." ? skillRoot : repo;

    return { tarGz, suggestedName };
  }
}
