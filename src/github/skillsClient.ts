/**
 * Remote repository client for fetching AI Tools Organizer content.
 *
 * Supports both GitHub and Azure DevOps repositories via a transport layer:
 *   - GitHubRepoTransport  — GitHub Git Trees API + raw.githubusercontent.com
 *   - AzureDevOpsRepoTransport — ADO Git Items API
 *
 * Discovery and YAML/JSON parsing are shared regardless of hosting provider.
 */

import * as vscode from 'vscode';
import { Skill, SkillRepository, SkillMetadata, CacheEntry, FailedRepository, readRepositoriesConfig, ContentArea, ALL_CONTENT_AREAS, AREA_DEFINITIONS, AreaFileItem, RepoContent, AreaPaths, isYamlBlockScalar, stripYamlQuotes, collectBlockScalarValue, getAreaFileSuffixes, deriveItemName, isAdoRepository, formatRepoLabel } from '../types';
import { RepoTransport, RepoTreeItem } from '../repos/repoTransport';
import { GitHubRepoTransport } from '../repos/githubRepoTransport';
import { AzureDevOpsRepoTransport } from '../repos/azureDevOpsRepoTransport';

export class GitHubSkillsClient {
    private cache: Map<string, CacheEntry<unknown>> = new Map();
    private ghTransport: GitHubRepoTransport;
    private adoTransport: AzureDevOpsRepoTransport;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.ghTransport = new GitHubRepoTransport(this.cache);
        this.adoTransport = new AzureDevOpsRepoTransport(this.cache);
    }

    /** Select the correct transport for a repository. */
    private transport(repo: SkillRepository): RepoTransport {
        return isAdoRepository(repo) ? this.adoTransport : this.ghTransport;
    }

    /**
     * Fetch all skills from configured repositories
     * 
     * API calls: 1 per repository (using Git Trees API)
     * File content: Fetched via raw.githubusercontent.com (no API limit)
     */
    async fetchAllSkills(): Promise<{ skills: Skill[]; failures: FailedRepository[] }> {
        const repositories = readRepositoriesConfig();
        
        const allSkills: Skill[] = [];
        const failures: FailedRepository[] = [];

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Fetching content...',
        }, async (progress) => {
            const results = await Promise.allSettled(
                repositories.map(async (repo) => {
                    progress.report({ message: formatRepoLabel(repo) });
                    const discovered = await this.discoverAreas(repo);
                    return this.fetchRepoContent(repo, discovered);
                })
            );

            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (result.status === 'fulfilled') {
                    allSkills.push(...result.value.skills);
                } else {
                    const repo = repositories[i];
                    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
                    console.error(`Failed to fetch content from ${repo.owner}/${repo.repo}:`, result.reason);
                    failures.push({ repo, error: message });
                }
            }
        });

        return { skills: allSkills, failures };
    }

    /**
     * Fetch the full recursive tree for a repository via the appropriate transport.
     */
    private async fetchRepoTree(repo: SkillRepository): Promise<RepoTreeItem[]> {
        return this.transport(repo).fetchRepoTree(repo);
    }

    /**
     * Fetch and parse a definition file (SKILL.md, plugin.json, etc.) for an item.
     */
    async fetchSkillMetadataRaw(repo: SkillRepository, skillName: string, skillPath: string, area: ContentArea = 'skills'): Promise<Skill | null> {
        const def = AREA_DEFINITIONS[area];
        const defFile = def.definitionFile || 'SKILL.md';
        const defFilePath = `${skillPath}/${defFile}`;

        try {
            const content = await this.fetchRawContent(repo, defFilePath);

            let name = skillName;
            let description = 'No description available';
            let license: string | undefined;
            let compatibility: string | undefined;
            let bodyContent: string | undefined;
            let readmeFullContent: string | undefined;

            if (defFile.endsWith('.json')) {
                // Parse JSON definition files (e.g. plugin.json, hooks.json)
                try {
                    const json = JSON.parse(content);
                    name = json.name || skillName;
                    description = json.description || description;
                    license = json.license;
                } catch {
                    // JSON parse failed — use folder name as fallback
                }

                // Try to fetch README.md from the same directory for body content
                try {
                    const readmePath = `${skillPath}/README.md`;
                    readmeFullContent = await this.fetchRawContent(repo, readmePath);
                    // Parse frontmatter from README if present
                    const readmeParsed = this.parseSkillMd(readmeFullContent);
                    bodyContent = readmeParsed.body || readmeFullContent;
                    // Use README frontmatter for name/description if JSON didn't provide them
                    if (name === skillName && readmeParsed.metadata.name) { name = readmeParsed.metadata.name; }
                    if (description === 'No description available' && readmeParsed.metadata.description) { description = readmeParsed.metadata.description; }
                } catch {
                    // No README.md, that's fine
                }
            } else {
                // Parse markdown frontmatter (SKILL.md, POWER.md)
                const parsed = this.parseSkillMd(content);
                name = parsed.metadata.name || skillName;
                description = parsed.metadata.description || description;
                license = parsed.metadata.license;
                compatibility = parsed.metadata.compatibility;
                bodyContent = parsed.body;
            }

            return {
                name,
                description,
                license,
                compatibility,
                source: repo,
                skillPath,
                area,
                fullContent: readmeFullContent || content,
                bodyContent,
                // For JSON-based areas, preserve the raw definition file content
                definitionContent: defFile.endsWith('.json') ? content : undefined
            };
        } catch (_error) {
            console.warn(`No ${defFile} found for ${skillName}`);
            return null;
        }
    }

    /**
     * Fetch raw file content via the appropriate transport.
     */
    private async fetchRawContent(repo: SkillRepository, path: string): Promise<string> {
        return this.transport(repo).fetchFileText(repo, path);
    }

    /**
     * Fetch raw file content (kept for backward compatibility with external callers).
     */
    async fetchFileContent(owner: string, repoName: string, path: string, branch: string): Promise<string> {
        const repo: SkillRepository = { owner, repo: repoName, branch };
        return this.fetchRawContent(repo, path);
    }

    /**
     * Fetch all files in a skill directory for installation.
     */
    async fetchSkillFiles(skill: Skill): Promise<{ path: string; content: string }[]> {
        // Get tree (likely cached from earlier fetch)
        const tree = await this.fetchRepoTree(skill.source);

        // Find all files under this skill's path
        const skillFiles = tree.filter(item =>
            item.type === 'blob' &&
            item.path.startsWith(skill.skillPath + '/')
        );

        // Fetch all file contents in parallel
        const files = await Promise.all(
            skillFiles.map(async (item) => {
                const relativePath = item.path.substring(skill.skillPath.length + 1);
                const content = await this.fetchRawContent(skill.source, item.path);
                return { path: relativePath, content };
            })
        );

        return files;
    }

    /**
     * Parse SKILL.md content into metadata and body
     */
    private parseSkillMd(content: string): { metadata: SkillMetadata; body: string } {
        const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        
        if (!frontmatterMatch) {
            // Try to extract basic info even without frontmatter
            return {
                metadata: { name: '', description: '' },
                body: content
            };
        }

        const yamlContent = frontmatterMatch[1];
        const body = frontmatterMatch[2];
        
        const metadata = this.parseYamlFrontmatter(yamlContent);
        
        return { metadata, body };
    }

    /**
     * Simple YAML frontmatter parser
     */
    private parseYamlFrontmatter(yaml: string): SkillMetadata {
        const metadata: SkillMetadata = { name: '', description: '' };
        
        const lines = yaml.split('\n');
        let currentKey = '';
        let multilineValue = '';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Check for key: value pattern
            const keyMatch = line.match(/^(\w+(?:-\w+)*):\s*(.*)$/);
            
            if (keyMatch) {
                // Save previous multiline value if any
                if (currentKey && multilineValue) {
                    this.setMetadataValue(metadata, currentKey, multilineValue.trim());
                }
                
                currentKey = keyMatch[1];
                const value = keyMatch[2].trim();
                
                // Detect YAML block scalar indicators (>, |, >-, |-, >+, |+, >2, etc.)
                if (isYamlBlockScalar(value)) {
                    const collected = collectBlockScalarValue(lines, i, value);
                    this.setMetadataValue(metadata, currentKey, collected);
                    currentKey = '';
                    multilineValue = '';
                } else if (value) {
                    this.setMetadataValue(metadata, currentKey, value);
                    currentKey = '';
                    multilineValue = '';
                } else {
                    multilineValue = '';
                }
            } else if (currentKey && line.startsWith('  ')) {
                multilineValue += line.trim() + ' ';
            }
        }
        
        // Handle last multiline value
        if (currentKey && multilineValue) {
            this.setMetadataValue(metadata, currentKey, multilineValue.trim());
        }
        
        return metadata;
    }

    private setMetadataValue(metadata: SkillMetadata, key: string, value: string): void {
        switch (key) {
            case 'name':
                metadata.name = stripYamlQuotes(value);
                break;
            case 'description':
                metadata.description = stripYamlQuotes(value);
                break;
            case 'license':
                metadata.license = value;
                break;
            case 'compatibility':
                metadata.compatibility = value;
                break;
            case 'allowed-tools':
                metadata.allowedTools = value;
                break;
        }
    }


    /**
     * Discover which content areas exist in a repository by scanning the tree.
     * Returns an AreaPaths mapping each found area to its path.
     * API calls: 1 (tree fetch — reuses cached result for subsequent calls)
     */
    async discoverAreas(repo: SkillRepository): Promise<AreaPaths> {
        const tree = await this.fetchRepoTree(repo);
        const result: AreaPaths = {};

        // Step 1: Check for top-level directories matching area names
        // This is the strongest signal — a folder named "skills", "agents", etc.
        const topLevelDirs = new Set(
            tree
                .filter(item => item.type === 'tree' && !item.path.includes('/'))
                .map(item => item.path)
        );

        // Map of conventional folder names to areas
        // Areas with conventionalDir override use that; others use the area key itself
        for (const area of ALL_CONTENT_AREAS) {
            const def = AREA_DEFINITIONS[area];
            const dirName = def.conventionalDir || area;
            if (!topLevelDirs.has(dirName)) { continue; }

            // If hooksGithub was already found for this dir, skip hooksKiro (they're mutually exclusive)
            if (area === 'hooksKiro' && result['hooksGithub'] !== undefined) { continue; }

            // Verify the directory actually contains matching content
            if (def.kind === 'multiFile' && def.definitionFile) {
                // Check primary definition file
                let hasContent = tree.some(item =>
                    item.type === 'blob' &&
                    item.path.startsWith(dirName + '/') &&
                    item.path.endsWith(`/${def.definitionFile}`)
                );
                // Also check alternate definition files (e.g. .cursor-plugin/plugin.json)
                if (!hasContent) {
                    hasContent = (def.alternateDefinitionFiles ?? []).some(alt =>
                        tree.some(item =>
                            item.type === 'blob' &&
                            item.path.startsWith(dirName + '/') &&
                            item.path.endsWith(`/${alt}`)
                        )
                    );
                }
                if (hasContent) { result[area] = dirName; }
            } else if (def.kind === 'singleFile') {
                const suffixes = getAreaFileSuffixes(def);
                const hasContent = tree.some(item =>
                    item.type === 'blob' &&
                    item.path.startsWith(dirName + '/') &&
                    suffixes.some(s => item.path.endsWith(s))
                );
                if (hasContent) { result[area] = dirName; }
            }
        }

        // Step 2: For areas not found via conventional names, search the full tree
        // but exclude files under already-discovered area paths
        const discoveredPrefixes = Object.values(result)
            .filter(p => p !== undefined && p !== '')
            .map(p => p + '/');

        for (const area of ALL_CONTENT_AREAS) {
            if (result[area] !== undefined) { continue; } // Already found

            const def = AREA_DEFINITIONS[area];
            if (def.conventionalOnly) { continue; } // Only discoverable via conventional top-level dir name

            if (def.kind === 'multiFile' && def.definitionFile) {
                // Collect all definition file candidates (primary + alternates)
                const defFileSuffixes = [def.definitionFile, ...(def.alternateDefinitionFiles ?? [])];
                const defFiles = tree.filter(item =>
                    item.type === 'blob' &&
                    defFileSuffixes.some(d => item.path.endsWith(`/${d}`) || item.path === d) &&
                    !discoveredPrefixes.some(p => item.path.startsWith(p))
                );
                if (defFiles.length > 0) {
                    const dirCounts = new Map<string, number>();
                    for (const item of defFiles) {
                        const itemRoot = this.resolvePluginRootFromDefPath(item.path);
                        const parentDir = itemRoot.includes('/')
                            ? itemRoot.substring(0, itemRoot.lastIndexOf('/'))
                            : '';
                        dirCounts.set(parentDir, (dirCounts.get(parentDir) || 0) + 1);
                    }
                    let bestDir = '';
                    let bestCount = 0;
                    for (const [dir, count] of dirCounts) {
                        if (count > bestCount) { bestDir = dir; bestCount = count; }
                    }
                    result[area] = bestDir;
                    if (bestDir) { discoveredPrefixes.push(bestDir + '/'); }
                }
            } else if (def.kind === 'singleFile') {
                const suffixes = getAreaFileSuffixes(def);
                const matchingFiles = tree.filter(item =>
                    item.type === 'blob' &&
                    suffixes.some(s => item.path.endsWith(s)) &&
                    !discoveredPrefixes.some(p => item.path.startsWith(p))
                );
                if (matchingFiles.length > 0) {
                    const dirCounts = new Map<string, number>();
                    for (const item of matchingFiles) {
                        const parts = item.path.split('/');
                        const dir = parts.length > 1 ? parts[0] : '';
                        dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
                    }
                    let bestDir = '';
                    let bestCount = 0;
                    for (const [dir, count] of dirCounts) {
                        if (count > bestCount) { bestDir = dir; bestCount = count; }
                    }
                    result[area] = bestDir;
                    if (bestDir) { discoveredPrefixes.push(bestDir + '/'); }
                }
            }
        }

        // Step 3: Check for a Cursor marketplace manifest (.cursor-plugin/marketplace.json).
        // This handles multi-plugin repos that list plugins explicitly.
        // Conventional plugins/ layout (Steps 1/2) takes precedence; marketplace is only used
        // when those steps did not find a plugins area.
        if (result['plugins'] === undefined) {
            const hasMarketplace = tree.some(
                item => item.type === 'blob' && item.path === '.cursor-plugin/marketplace.json'
            );
            if (hasMarketplace) {
                // Signal that this repo uses the Cursor marketplace format;
                // actual per-plugin expansion happens in fetchRepoContent.
                result['plugins'] = '.cursor-plugin/marketplace';
            }
        }

        return result;
    }

    /**
     * Given a definition file blob path, resolve the plugin root directory by removing
     * the definition filename and any trailing wrapper directory segments
     * (e.g. `.cursor-plugin`, `.claude-plugin`, `plugin`, `hooks`).
     *
     * Examples:
     *   "my-plugin/.cursor-plugin/plugin.json" → "my-plugin"
     *   ".cursor-plugin/plugin.json"            → ""  (repo root)
     *   "plugins/my-plugin/plugin.json"         → "plugins/my-plugin"
     */
    private resolvePluginRootFromDefPath(blobPath: string): string {
        const segments = blobPath.split('/');
        // Remove the filename
        segments.pop();
        // Remove trailing wrapper segments
        while (segments.length > 0) {
            const last = segments[segments.length - 1];
            if (last.startsWith('.') || last === 'plugin' || last === 'hooks') {
                segments.pop();
            } else {
                break;
            }
        }
        return segments.join('/');
    }

    /**
     * Fetch all content from a repository across all discovered areas.
     * Returns skills (multi-file items) and fileItems (single-file items).
     * API calls: 1 for tree + N raw content fetches (no rate limit)
     */
    async fetchRepoContent(repo: SkillRepository, areaPaths: AreaPaths): Promise<RepoContent> {
        const tree = await this.fetchRepoTree(repo);
        const paths = areaPaths;

        const skills: Skill[] = [];
        const fileItems: AreaFileItem[] = [];

        // Build exclusion prefixes: all configured area paths except the current one
        // This prevents e.g. a .prompt.md inside a plugin folder from appearing under Prompts
        const allAreaPrefixes = new Map<ContentArea, string>();
        for (const a of ALL_CONTENT_AREAS) {
            const p = paths[a];
            if (p !== undefined && p !== '') {
                allAreaPrefixes.set(a, p + '/');
            }
        }

        // Process each area that has a path configured
        for (const area of ALL_CONTENT_AREAS) {
            const areaPath = paths[area];
            if (areaPath === undefined) { continue; }

            const def = AREA_DEFINITIONS[area];

            // Exclusion prefixes: other area paths that differ from this area's path
            const currentPrefix = areaPath ? areaPath + '/' : '';
            const otherPrefixes = [...allAreaPrefixes.entries()]
                .filter(([a, prefix]) => a !== area && prefix !== currentPrefix)
                .map(([, prefix]) => prefix);

            if (def.kind === 'multiFile' && def.definitionFile) {
                // Handle Cursor marketplace path — expand from .cursor-plugin/marketplace.json
                if (areaPath === '.cursor-plugin/marketplace') {
                    const marketplaceSkills = await this.fetchCursorMarketplacePlugins(repo, tree, otherPrefixes);
                    skills.push(...marketplaceSkills);
                    continue;
                }

                const prefix = areaPath ? areaPath + '/' : '';
                // Match both primary and alternate definition file suffixes
                const defCandidates = [def.definitionFile, ...(def.alternateDefinitionFiles ?? [])];
                const defFiles = tree.filter(item =>
                    item.type === 'blob' &&
                    item.path.startsWith(prefix) &&
                    defCandidates.some(d => item.path.endsWith(`/${d}`)) &&
                    !otherPrefixes.some(op => item.path.startsWith(op))
                );

                // Deduplicate: find the item root folder for each definition file.
                // The item root is determined by removing the definition file and any
                // known wrapper directories (e.g. .claude-plugin/, .cursor-plugin/, .github/plugin/).
                const seenItems = new Map<string, string>(); // itemDir → first defFile path
                for (const item of defFiles) {
                    const itemRoot = this.resolvePluginRootFromDefPath(item.path);
                    const itemDir = itemRoot || (prefix ? prefix.replace(/\/$/, '') : '');
                    if (!seenItems.has(itemDir)) {
                        seenItems.set(itemDir, item.path);
                    }
                }

                const items = await Promise.all(
                    [...seenItems.entries()].map(async ([itemDir, defFilePath]) => {
                        const skillName = itemDir.split('/').pop() || itemDir;
                        // Use the actual definition file path's parent for metadata fetching
                        const defParentDir = defFilePath.substring(0, defFilePath.lastIndexOf('/'));
                        try {
                            const skill = await this.fetchSkillMetadataRaw(repo, skillName, defParentDir, area);
                            // Override skillPath to point to the item's root folder (not the nested def file location)
                            if (skill) {
                                skill.skillPath = itemDir;
                                // If README wasn't found at the def file location, try the item root
                                if (!skill.bodyContent && defParentDir !== itemDir) {
                                    try {
                                        const readmePath = `${itemDir}/README.md`;
                                        const readmeContent = await this.fetchRawContent(repo, readmePath);
                                        const readmeParsed = this.parseSkillMd(readmeContent);
                                        skill.bodyContent = readmeParsed.body || readmeContent;
                                        skill.fullContent = readmeContent;
                                        if (skill.name === skillName && readmeParsed.metadata.name) { skill.name = readmeParsed.metadata.name; }
                                        if (skill.description === 'No description available' && readmeParsed.metadata.description) { skill.description = readmeParsed.metadata.description; }
                                    } catch { /* no README at root either */ }
                                }
                            }
                            return skill;
                        } catch (error) {
                            console.warn(`Failed to fetch ${area} at ${itemDir}:`, error);
                            return null;
                        }
                    })
                );
                skills.push(...items.filter((s): s is Skill => s !== null));

            } else if (def.kind === 'singleFile') {
                const suffixes = getAreaFileSuffixes(def);
                const prefix = areaPath ? areaPath + '/' : '';
                const matchingFiles = tree.filter(item =>
                    item.type === 'blob' &&
                    (areaPath === ''
                        ? suffixes.some(s => item.path.endsWith(s))
                        : item.path.startsWith(prefix) && suffixes.some(s => item.path.endsWith(s))
                    ) &&
                    !otherPrefixes.some(op => item.path.startsWith(op))
                );

                // Deduplicate by display name (prefer more-specific suffix, already ordered in fileSuffixes)
                const seenNames = new Set<string>();
                for (const item of matchingFiles) {
                    const fileName = item.path.split('/').pop() || item.path;
                    const name = deriveItemName(fileName, def);
                    if (seenNames.has(name)) { continue; }
                    seenNames.add(name);

                    const relativePath = areaPath ? item.path.substring(prefix.length) : item.path;
                    const folderPath = relativePath.includes('/')
                        ? relativePath.substring(0, relativePath.lastIndexOf('/'))
                        : '';

                    fileItems.push({
                        name,
                        filePath: item.path,
                        area,
                        source: repo,
                        folderPath,
                    });
                }
            }
        }

        return { skills, fileItems };
    }

    /**
     * Expand a Cursor marketplace manifest (.cursor-plugin/marketplace.json) into Skill entries.
     * Each entry in the manifest's `plugins` array becomes one plugin Skill.
     * Per-plugin .cursor-plugin/plugin.json manifests are merged in (marketplace entry wins on
     * name/description if provided).
     *
     * @param repo Source repository
     * @param treeItems Full tree blob list (used to verify plugin manifests exist)
     * @param otherPrefixes Prefixes already claimed by other areas (exclusion list)
     */
    private async fetchCursorMarketplacePlugins(
        repo: SkillRepository,
        treeItems: RepoTreeItem[],
        otherPrefixes: string[]
    ): Promise<Skill[]> {
        let marketplaceJson: unknown;
        try {
            const raw = await this.fetchRawContent(repo, '.cursor-plugin/marketplace.json');
            marketplaceJson = JSON.parse(raw);
        } catch {
            return [];
        }

        if (!marketplaceJson || typeof marketplaceJson !== 'object') { return []; }
        const manifest = marketplaceJson as Record<string, unknown>;
        const pluginsArray = manifest['plugins'];
        if (!Array.isArray(pluginsArray)) { return []; }

        // Optional global prefix for all plugin source paths
        const pluginRoot = (manifest['metadata'] as Record<string, unknown> | undefined)?.['pluginRoot'];
        const globalPrefix = typeof pluginRoot === 'string' && pluginRoot ? pluginRoot.replace(/\/+$/, '') : '';

        const skills: Skill[] = [];

        for (const entry of pluginsArray) {
            if (!entry || typeof entry !== 'object') { continue; }
            const e = entry as Record<string, unknown>;

            const entryName = typeof e['name'] === 'string' ? e['name'] : '';
            const entryDesc = typeof e['description'] === 'string' ? e['description'] : '';

            // Resolve source path
            const rawSource = typeof e['source'] === 'string'
                ? e['source']
                : (e['source'] && typeof e['source'] === 'object' && typeof (e['source'] as Record<string, unknown>)['path'] === 'string'
                    ? (e['source'] as Record<string, unknown>)['path'] as string
                    : '');
            if (!rawSource || rawSource.includes('..')) { continue; }
            const pluginDir = globalPrefix ? `${globalPrefix}/${rawSource}` : rawSource;

            // Reject paths outside the repo or already claimed by another area
            if (otherPrefixes.some(p => pluginDir.startsWith(p))) { continue; }

            // Verify the plugin has a manifest in the tree
            const manifestPath = `${pluginDir}/.cursor-plugin/plugin.json`;
            const hasManifest = treeItems.some(i => i.type === 'blob' && i.path === manifestPath);
            if (!hasManifest) { continue; }

            // Fetch per-plugin manifest and merge (per-plugin wins on name/description)
            let name = entryName || pluginDir.split('/').pop() || pluginDir;
            let description = entryDesc;
            let bodyContent: string | undefined;
            let fullContent: string | undefined;
            try {
                const perPluginRaw = await this.fetchRawContent(repo, manifestPath);
                const perPlugin = JSON.parse(perPluginRaw) as Record<string, unknown>;
                if (typeof perPlugin['name'] === 'string' && perPlugin['name']) { name = perPlugin['name']; }
                if (typeof perPlugin['description'] === 'string' && perPlugin['description']) { description = perPlugin['description']; }
                fullContent = perPluginRaw;
            } catch { /* missing or invalid per-plugin manifest */ }

            // Try README.md at the plugin root for body content
            try {
                const readmeRaw = await this.fetchRawContent(repo, `${pluginDir}/README.md`);
                const parsed = this.parseSkillMd(readmeRaw);
                bodyContent = parsed.body || readmeRaw;
                if (!fullContent) { fullContent = readmeRaw; }
            } catch { /* no README */ }

            skills.push({
                name,
                description: description || 'No description available',
                source: repo,
                skillPath: pluginDir,
                area: 'plugins',
                fullContent,
                bodyContent,
                definitionContent: fullContent,
            });
        }

        return skills;
    }

    /**
     * Fetch the default branch for a repository via the appropriate transport.
     */
    async fetchDefaultBranch(repo: SkillRepository): Promise<string> {
        return this.transport(repo).fetchDefaultBranch(repo);
    }

    /**
     * Clear all cached data
     */
    clearCache(): void {
        this.cache.clear();
    }
}
