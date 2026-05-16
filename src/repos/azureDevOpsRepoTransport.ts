/**
 * Azure DevOps implementation of RepoTransport.
 *
 * Tree listing:
 *   - fetchRootTreeEntries: Items API with recursionLevel=OneLevel, scopePath=/.
 *   - fetchSubtreeRecursive: Items API with recursionLevel=Full, scopePath=/{prefix}.
 * File content : Git Items API with download=true.
 * Default branch: Git Repositories API (strips "refs/heads/" prefix).
 *
 * Auth: HTTP Basic with empty username + PAT from AIToolsOrganizer.azureDevOpsPat,
 * or if unset, from the AZURE_DEVOPS_EXT_PAT environment variable.
 * For public projects PAT may be omitted, but many org-level projects require it.
 */

import * as vscode from 'vscode';
import { SkillRepository, CacheEntry } from '../types';
import { RepoTransport, RepoTreeItem } from './repoTransport';

interface AdoItemEntry {
    path: string;
    isFolder: boolean;
}

interface AdoItemsResponse {
    value: AdoItemEntry[];
    count: number;
}

interface AdoRepoInfo {
    defaultBranch: string;
}

const ADO_API_VERSION = '7.1';

export class AzureDevOpsRepoTransport implements RepoTransport {
    constructor(private readonly cache: Map<string, CacheEntry<unknown>>) {}

    /**
     * Fetch only the immediate children of the repository root (one level deep).
     */
    async fetchRootTreeEntries(repo: SkillRepository): Promise<RepoTreeItem[]> {
        const branch = repo.branch || 'main';
        const cacheKey = `ado:root:${repo.owner}/${repo.project}/${repo.repo}@${branch}`;
        const cached = this.getFromCache<AdoItemEntry[]>(cacheKey);
        if (cached) { return this.normalizeItems(cached, ''); }

        const base = this.baseUrl(repo);
        const params = new URLSearchParams({
            'scopePath': '/',
            'recursionLevel': 'OneLevel',
            'versionDescriptor.version': branch,
            'versionDescriptor.versionType': 'branch',
            'api-version': ADO_API_VERSION,
        });
        const url = `${base}/_apis/git/repositories/${encodeURIComponent(repo.repo)}/items?${params}`;

        const response = await this.fetchWithAuth(url);

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                vscode.window.showErrorMessage(
                    `Azure DevOps authentication failed (${response.status}). ` +
                    'Set a Personal Access Token with Code (read) permission in AIToolsOrganizer.azureDevOpsPat or the AZURE_DEVOPS_EXT_PAT environment variable.'
                );
            }
            if (response.status === 404) {
                throw new Error(`Azure DevOps repository or branch not found: ${repo.owner}/${repo.project}/${repo.repo}@${branch}`);
            }
            throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as AdoItemsResponse;
        this.setCache(cacheKey, data.value);
        return this.normalizeItems(data.value, '');
    }

    /**
     * Recursively fetch all items under `prefixPath`.
     */
    async fetchSubtreeRecursive(repo: SkillRepository, prefixPath: string): Promise<RepoTreeItem[]> {
        const branch = repo.branch || 'main';
        const cacheKey = `ado:subtree:${repo.owner}/${repo.project}/${repo.repo}/${prefixPath}@${branch}`;
        const cached = this.getFromCache<AdoItemEntry[]>(cacheKey);
        if (cached) { return this.normalizeItems(cached, prefixPath); }

        const base = this.baseUrl(repo);
        const scopePath = prefixPath.startsWith('/') ? prefixPath : `/${prefixPath}`;
        const params = new URLSearchParams({
            'scopePath': scopePath,
            'recursionLevel': 'Full',
            'versionDescriptor.version': branch,
            'versionDescriptor.versionType': 'branch',
            'api-version': ADO_API_VERSION,
        });
        const url = `${base}/_apis/git/repositories/${encodeURIComponent(repo.repo)}/items?${params}`;

        const response = await this.fetchWithAuth(url);

        if (!response.ok) {
            if (response.status === 404) {
                // Subtree doesn't exist — not an error, return empty
                return [];
            }
            if (response.status === 401 || response.status === 403) {
                vscode.window.showErrorMessage(
                    `Azure DevOps authentication failed (${response.status}). ` +
                    'Check AIToolsOrganizer.azureDevOpsPat or the AZURE_DEVOPS_EXT_PAT environment variable.'
                );
            }
            throw new Error(`Azure DevOps API error fetching subtree ${prefixPath}: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as AdoItemsResponse;
        this.setCache(cacheKey, data.value);
        return this.normalizeItems(data.value, prefixPath);
    }

    /**
     * Normalise ADO item entries to the common RepoTreeItem shape:
     * - Strip the mandatory leading `/` from ADO paths.
     * - Map isFolder to type.
     * - Skip the root/scope entry itself (path matches scopePath exactly).
     */
    private normalizeItems(items: AdoItemEntry[], scopePrefix: string): RepoTreeItem[] {
        const skipPath = scopePrefix ? `/${scopePrefix}` : '/';
        return items
            .filter(item => item.path !== '/' && item.path !== skipPath)
            .map(item => ({
                path: item.path.startsWith('/') ? item.path.slice(1) : item.path,
                type: item.isFolder ? 'tree' as const : 'blob' as const,
            }));
    }

    async fetchFileText(repo: SkillRepository, path: string): Promise<string> {
        const branch = repo.branch || 'main';
        const cacheKey = `ado:file:${repo.owner}/${repo.project}/${repo.repo}/${path}@${branch}`;
        const cached = this.getFromCache<string>(cacheKey);
        if (cached) { return cached; }

        const base = this.baseUrl(repo);
        const filePath = path.startsWith('/') ? path : `/${path}`;
        const params = new URLSearchParams({
            'path': filePath,
            'versionDescriptor.version': branch,
            'versionDescriptor.versionType': 'branch',
            'download': 'true',
            'api-version': ADO_API_VERSION,
        });
        const url = `${base}/_apis/git/repositories/${encodeURIComponent(repo.repo)}/items?${params}`;

        // Use text/plain Accept to get raw file content — application/json would cause
        // ADO to return JSON metadata even when download=true is set.
        const response = await this.fetchWithAuth(url, 'text/plain');

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                vscode.window.showErrorMessage(
                    `Azure DevOps authentication failed (${response.status}). ` +
                    'Check AIToolsOrganizer.azureDevOpsPat or the AZURE_DEVOPS_EXT_PAT environment variable.'
                );
            }
            throw new Error(`Failed to fetch file from Azure DevOps: ${response.status}`);
        }

        const content = await response.text();
        this.setCache(cacheKey, content);
        return content;
    }

    async fetchDefaultBranch(repo: SkillRepository): Promise<string> {
        const cacheKey = `ado:default-branch:${repo.owner}/${repo.project}/${repo.repo}`;
        const cached = this.getFromCache<string>(cacheKey);
        if (cached) { return cached; }

        const base = this.baseUrl(repo);
        const url = `${base}/_apis/git/repositories/${encodeURIComponent(repo.repo)}?api-version=${ADO_API_VERSION}`;

        const response = await this.fetchWithAuth(url);
        if (!response.ok) {
            return 'main';
        }

        const data = await response.json() as AdoRepoInfo;
        // ADO returns "refs/heads/main" — strip the prefix
        const branch = (data.defaultBranch || 'refs/heads/main').replace(/^refs\/heads\//, '');
        this.setCache(cacheKey, branch);
        return branch;
    }

    private baseUrl(repo: SkillRepository): string {
        return `https://dev.azure.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.project!)}`;
    }

    /**
     * PAT resolution: user setting first, then AZURE_DEVOPS_EXT_PAT (e.g. CI or shell profile).
     */
    private getAzureDevOpsPat(): string {
        const config = vscode.workspace.getConfiguration('AIToolsOrganizer');
        const fromSettings = (config.get<string>('azureDevOpsPat', '') || '').trim();
        if (fromSettings) {
            return fromSettings;
        }
        return (process.env.AZURE_DEVOPS_EXT_PAT || '').trim();
    }

    private async fetchWithAuth(url: string, accept = 'application/json'): Promise<Response> {
        const pat = this.getAzureDevOpsPat();

        const headers: Record<string, string> = {
            'Accept': accept,
        };

        if (pat) {
            // ADO PAT auth: Basic with empty username
            headers['Authorization'] = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
        }

        return fetch(url, { headers });
    }

    private getFromCache<T>(key: string): T | null {
        const entry = this.cache.get(key) as CacheEntry<T> | undefined;
        if (!entry) { return null; }

        const config = vscode.workspace.getConfiguration('AIToolsOrganizer');
        const timeout = config.get<number>('cacheTimeout', 3600) * 1000;

        if (Date.now() - entry.timestamp > timeout) {
            this.cache.delete(key);
            return null;
        }

        return entry.data;
    }

    private setCache<T>(key: string, data: T): void {
        this.cache.set(key, { data, timestamp: Date.now() });
    }
}
