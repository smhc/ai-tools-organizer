/**
 * Azure DevOps implementation of RepoTransport.
 *
 * Tree listing : Git Items API with recursionLevel=Full (1 call per repo/branch).
 * File content : Git Items API with download=true.
 * Default branch: Git Repositories API (strips "refs/heads/" prefix).
 *
 * Auth: HTTP Basic with empty username + PAT read from AIToolsOrganizer.azureDevOpsPat.
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
const LARGE_TREE_THRESHOLD = 5000;

export class AzureDevOpsRepoTransport implements RepoTransport {
    constructor(private readonly cache: Map<string, CacheEntry<unknown>>) {}

    async fetchRepoTree(repo: SkillRepository): Promise<RepoTreeItem[]> {
        const branch = repo.branch || 'main';
        const cacheKey = `ado:tree:${repo.owner}/${repo.project}/${repo.repo}@${branch}`;
        const cached = this.getFromCache<AdoItemEntry[]>(cacheKey);
        if (cached) { return this.normalizeItems(cached); }

        const base = this.baseUrl(repo);
        const params = new URLSearchParams({
            'scopePath': '/',
            'recursionLevel': 'Full',
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
                    'Set a Personal Access Token with Code (read) permission in the AIToolsOrganizer.azureDevOpsPat setting.'
                );
            }
            if (response.status === 404) {
                throw new Error(`Azure DevOps repository or branch not found: ${repo.owner}/${repo.project}/${repo.repo}@${branch}`);
            }
            throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as AdoItemsResponse;

        if (data.count >= LARGE_TREE_THRESHOLD) {
            console.warn(
                `ADO tree for ${repo.owner}/${repo.project}/${repo.repo} has ${data.count} items. ` +
                'Some content may be slow to load.'
            );
        }

        this.setCache(cacheKey, data.value);
        return this.normalizeItems(data.value);
    }

    /**
     * Normalise ADO item entries to the common RepoTreeItem shape:
     * - Strip the mandatory leading `/` from ADO paths.
     * - Map isFolder to type.
     * - Skip the root entry (path === '/') produced by scopePath=/.
     */
    private normalizeItems(items: AdoItemEntry[]): RepoTreeItem[] {
        return items
            .filter(item => item.path !== '/')
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

        const response = await this.fetchWithAuth(url);

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                vscode.window.showErrorMessage(
                    `Azure DevOps authentication failed (${response.status}). ` +
                    'Check the AIToolsOrganizer.azureDevOpsPat setting.'
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

    private async fetchWithAuth(url: string): Promise<Response> {
        const config = vscode.workspace.getConfiguration('AIToolsOrganizer');
        const pat = config.get<string>('azureDevOpsPat', '');

        const headers: Record<string, string> = {
            'Accept': 'application/json',
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
