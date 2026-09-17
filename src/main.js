import Storehouse from 'storehouse-js';
import * as monaco from 'monaco-editor';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';

const init = () => {
    let hasEdited = false;
    let scrollBarSync = false;

    const localStorageNamespace = 'com.markdownlivepreview';
    const localStorageKey = 'last_state';
    const localStorageWorkspaceKey = 'document_workspace';
    const localStorageSidebarKey = 'sidebar_collapsed';
    const localStorageScrollBarKey = 'scroll_bar_settings';
    const localStorageThemeKey = 'theme_settings';
    const confirmationMessage = 'Are you sure you want to reset? Your changes will be lost.';
    let mermaidRenderTimer = null;
    let mermaidRenderVersion = 0;
    let editor;
    let tabs = [];
    let activeTabId = null;
    let editorViewStates = new Map();
    // default template
    const defaultInput = `# Markdown syntax guide

## Headers

# This is a Heading h1
## This is a Heading h2
###### This is a Heading h6

## Emphasis

*This text will be italic*  
_This will also be italic_

**This text will be bold**  
__This will also be bold__

_You **can** combine them_

## Lists

### Unordered

* Item 1
* Item 2
* Item 2a
* Item 2b
    * Item 3a
    * Item 3b

### Ordered

1. Item 1
2. Item 2
3. Item 3
    1. Item 3a
    2. Item 3b

## Images

![This is an alt text.](/image/Markdown-mark.svg "This is a sample image.")

## Links

You may be using [Markdown Live Preview](https://markdownlivepreview.com/).

## Blockquotes

> Markdown is a lightweight markup language with plain-text-formatting syntax, created in 2004 by John Gruber with Aaron Swartz.
>
>> Markdown is often used to format readme files, for writing messages in online discussion forums, and to create rich text using a plain text editor.

## Tables

| Left columns  | Right columns |
| ------------- |:-------------:|
| left foo      | right foo     |
| left bar      | right bar     |
| left baz      | right baz     |

## Blocks of code

${"`"}${"`"}${"`"}
let message = 'Hello world';
alert(message);
${"`"}${"`"}${"`"}

## Mermaid diagrams
${"`"}${"`"}${"`"}mermaid
graph TD
  A[Start] --> B{Decision}
  B -->|Yes| C[Finish]
  B -->|No| D[Alternate]
${"`"}${"`"}${"`"}

## Inline code

This web site is using ${"`"}markedjs/marked${"`"}.
`;

    self.MonacoEnvironment = {
        getWorker(_, label) {
            return new Proxy({}, { get: () => () => { } });
        }
    }

    let setupEditor = () => {
        const instance = monaco.editor.create(document.querySelector('#editor'), {
            fontSize: 14,
            language: 'markdown',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            scrollbar: {
                vertical: 'visible',
                horizontal: 'visible'
            },
            wordWrap: 'on',
            hover: { enabled: false },
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            folding: false
        });

        instance.onDidChangeModelContent(() => {
            const activeTab = getActiveTab();
            if (!activeTab) return;
            const value = instance.getValue();
            activeTab.content = value;
            activeTab.updatedAt = Date.now();
            let changed = value != defaultInput;
            if (changed) {
                hasEdited = true;
            }
            convert(value);
            saveWorkspace();
            saveLastContent(value); // Keep the legacy value available for existing users.
            renderTabs();
        });

        instance.onDidScrollChange((e) => {
            if (!scrollBarSync) {
                return;
            }

            const scrollTop = e.scrollTop;
            const scrollHeight = e.scrollHeight;
            const height = instance.getLayoutInfo().height;

            const maxScrollTop = scrollHeight - height;
            const scrollRatio = scrollTop / maxScrollTop;

            let previewElement = document.querySelector('#preview');
            let targetY = (previewElement.scrollHeight - previewElement.clientHeight) * scrollRatio;
            previewElement.scrollTo(0, targetY);
        });

        return instance;
    };

    let escapeHtml = (value) => {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    let createMarkedRenderer = () => {
        const renderer = new marked.Renderer();
        const renderCode = renderer.code.bind(renderer);

        renderer.code = (token) => {
            const lang = (token.lang || '').match(/^\S*/)?.[0].toLowerCase();
            if (lang !== 'mermaid') {
                return renderCode(token);
            }

            return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
        };

        return renderer;
    };

    let configureMermaid = (theme) => {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme
        });
    };

    let showMermaidError = (element, error) => {
        const message = error && error.message ? error.message : 'Unable to render Mermaid chart.';
        element.classList.add('mermaid-error');
        element.textContent = `Mermaid render error: ${message}`;
    };

    let getMermaidTheme = () => {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
    };

    let renderMermaidDiagramsNow = async (theme = getMermaidTheme()) => {
        const outputElement = document.querySelector('#output');
        if (!outputElement) {
            return;
        }

        const version = ++mermaidRenderVersion;
        configureMermaid(theme);

        const elements = Array.from(outputElement.querySelectorAll('.mermaid'));
        for (const [index, element] of elements.entries()) {
            if (version !== mermaidRenderVersion) {
                return;
            }

            const source = element.dataset.mermaidSource || element.textContent;
            element.dataset.mermaidSource = source;
            element.classList.remove('mermaid-error');

            try {
                const renderId = `mermaid-${Date.now()}-${version}-${index}`;
                const { svg, bindFunctions } = await mermaid.render(renderId, source);
                if (version !== mermaidRenderVersion) {
                    return;
                }
                element.innerHTML = svg;
                if (typeof bindFunctions === 'function') {
                    bindFunctions(element);
                }
            } catch (error) {
                showMermaidError(element, error);
            }
        }
    };

    let scheduleMermaidRender = () => {
        if (mermaidRenderTimer) {
            clearTimeout(mermaidRenderTimer);
        }

        mermaidRenderTimer = setTimeout(() => {
            mermaidRenderTimer = null;
            renderMermaidDiagramsNow();
        }, 150);
    };

    let renderMermaidDiagrams = (theme) => {
        if (mermaidRenderTimer) {
            clearTimeout(mermaidRenderTimer);
            mermaidRenderTimer = null;
        }

        return renderMermaidDiagramsNow(theme);
    };

    let renderer = createMarkedRenderer();

    // Render markdown text as html
    let convert = (markdown) => {
        let options = {
            headerIds: false,
            mangle: false,
            renderer
        };
        let html = marked.parse(markdown, options);
        let sanitized = DOMPurify.sanitize(html);
        document.querySelector('#output').innerHTML = sanitized;
        scheduleMermaidRender();
    };

    // ----- document workspace -----

    const getActiveTab = () => tabs.find((tab) => tab.id === activeTabId);

    const createTabId = () => `document-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const cleanTabTitle = (title) => {
        const cleaned = String(title || '').trim().replace(/\s+/g, ' ');
        return cleaned || 'Untitled document';
    };

    const createTab = ({ title = 'Untitled document', content = '' } = {}) => {
        const id = createTabId();
        const tab = {
            id,
            title: cleanTabTitle(title),
            content: String(content),
            updatedAt: Date.now(),
            model: monaco.editor.createModel(String(content), 'markdown', monaco.Uri.parse(`inmemory://markdown-studio/${id}.md`))
        };
        tabs.push(tab);
        return tab;
    };

    const saveWorkspace = () => {
        const expiredAt = new Date(2099, 1, 1);
        const state = {
            activeTabId,
            tabs: tabs.map(({ id, title, content, updatedAt }) => ({ id, title, content, updatedAt }))
        };
        Storehouse.setItem(localStorageNamespace, localStorageWorkspaceKey, state, expiredAt);
    };

    const loadWorkspace = () => {
        const saved = Storehouse.getItem(localStorageNamespace, localStorageWorkspaceKey);
        if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) {
            return null;
        }

        const restoredTabs = saved.tabs
            .filter((tab) => tab && typeof tab.content === 'string')
            .map((tab) => ({
                id: typeof tab.id === 'string' ? tab.id : createTabId(),
                title: cleanTabTitle(tab.title),
                content: tab.content,
                updatedAt: typeof tab.updatedAt === 'number' ? tab.updatedAt : Date.now()
            }));

        if (!restoredTabs.length) return null;
        return {
            tabs: restoredTabs,
            activeTabId: restoredTabs.some((tab) => tab.id === saved.activeTabId) ? saved.activeTabId : restoredTabs[0].id
        };
    };

    const documentIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.75 3.75h7.1l4.4 4.4v12.1H6.75a1 1 0 0 1-1-1v-14.5a1 1 0 0 1 1-1Zm6.5 1.8v3.3h3.3"/></svg>';
    const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
    const editIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.75 16.75-.5 3.5 3.5-.5L18.4 9.1a2.05 2.05 0 0 0-2.9-2.9L4.75 16.75ZM13.9 7.8l2.3 2.3"/></svg>';

    const formatLastUpdated = (updatedAt) => {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
        if (elapsedSeconds < 45) return 'Last updated: just now';
        const elapsedMinutes = Math.floor(elapsedSeconds / 60);
        if (elapsedMinutes < 60) return `Last updated: ${elapsedMinutes} min ago`;
        const elapsedHours = Math.floor(elapsedMinutes / 60);
        if (elapsedHours < 24) return `Last updated: ${elapsedHours} hr ago`;
        const elapsedDays = Math.floor(elapsedHours / 24);
        return `Last updated: ${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
    };

    const updateDocumentBar = () => {
        const activeTab = getActiveTab();
        const documentName = document.querySelector('#current-document-name');
        const updated = document.querySelector('#document-updated');
        if (!activeTab) return;
        if (documentName) documentName.textContent = activeTab.title;
        if (updated) updated.textContent = formatLastUpdated(activeTab.updatedAt);
    };

    const renderTabs = () => {
        const list = document.querySelector('#tab-list');
        if (!list) return;
        updateDocumentBar();
        list.innerHTML = '';

        tabs.forEach((tab) => {
            const item = document.createElement('div');
            item.className = `tab-item${tab.id === activeTabId ? ' active' : ''}`;
            item.dataset.tabId = tab.id;

            const select = document.createElement('button');
            select.type = 'button';
            select.className = 'tab-select';
            select.setAttribute('role', 'tab');
            select.setAttribute('aria-selected', String(tab.id === activeTabId));
            select.setAttribute('title', tab.title);
            select.innerHTML = `<span class="tab-file-icon">${documentIcon}</span><span class="tab-copy"><span class="tab-name"></span></span>`;
            select.querySelector('.tab-name').textContent = tab.title;
            select.addEventListener('click', () => switchTab(tab.id));
            select.addEventListener('dblclick', () => startRenamingTab(tab.id));

            const rename = document.createElement('button');
            rename.type = 'button';
            rename.className = 'tab-action rename-tab';
            rename.setAttribute('aria-label', `Rename ${tab.title}`);
            rename.setAttribute('title', 'Rename document');
            rename.innerHTML = editIcon;
            rename.addEventListener('click', (event) => {
                event.stopPropagation();
                startRenamingTab(tab.id);
            });

            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'tab-action close-tab';
            close.setAttribute('aria-label', `Close ${tab.title}`);
            close.setAttribute('title', 'Close document');
            close.innerHTML = closeIcon;
            close.addEventListener('click', (event) => {
                event.stopPropagation();
                closeTab(tab.id);
            });

            item.append(select, rename, close);
            list.appendChild(item);
        });
    };

    const startRenamingTab = (id) => {
        const tab = tabs.find((item) => item.id === id);
        const item = document.querySelector(`.tab-item[data-tab-id="${id}"]`);
        if (!tab || !item || item.querySelector('.tab-name-input')) return;

        const copy = item.querySelector('.tab-copy');
        const name = item.querySelector('.tab-name');
        const input = document.createElement('input');
        input.className = 'tab-name-input';
        input.value = tab.title;
        input.maxLength = 80;
        input.setAttribute('aria-label', 'Document name');
        name.replaceWith(input);
        item.classList.add('renaming');

        const finish = (save) => {
            if (!input.isConnected) return;
            if (save) {
                tab.title = cleanTabTitle(input.value);
                tab.updatedAt = Date.now();
            }
            saveWorkspace();
            renderTabs();
        };
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            }
        });
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    };

    const switchTab = (id, focusEditor = true) => {
        const nextTab = tabs.find((tab) => tab.id === id);
        if (!nextTab || id === activeTabId) return;
        const currentModel = editor.getModel();
        if (currentModel && activeTabId) editorViewStates.set(activeTabId, editor.saveViewState());
        activeTabId = id;
        editor.setModel(nextTab.model);
        const viewState = editorViewStates.get(id);
        if (viewState) editor.restoreViewState(viewState);
        editor.layout();
        convert(nextTab.content);
        hasEdited = nextTab.content !== defaultInput;
        document.querySelector('#preview').scrollTo({ top: 0 });
        renderTabs();
        saveWorkspace();
        if (focusEditor) editor.focus();
    };

    const addNewTab = ({ title = 'Untitled document', content = '# New document\n\nStart writing…\n', rename = true } = {}) => {
        const tab = createTab({ title, content });
        switchTab(tab.id);
        if (rename) setTimeout(() => startRenamingTab(tab.id), 80);
        return tab;
    };

    const closeTab = (id) => {
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index === -1) return;
        const [closing] = tabs.splice(index, 1);
        const wasActive = id === activeTabId;
        editorViewStates.delete(id);

        if (!tabs.length) {
            const fresh = createTab({ title: 'Untitled document', content: '# New document\n\nStart writing…\n' });
            activeTabId = null;
            switchTab(fresh.id);
            closing.model.dispose();
            startRenamingTab(fresh.id);
            return;
        }

        if (wasActive) {
            activeTabId = null;
            switchTab(tabs[Math.max(0, index - 1)].id);
            closing.model.dispose();
        } else {
            closing.model.dispose();
            renderTabs();
            saveWorkspace();
        }
    };

    const setupWorkspace = () => {
        const restored = loadWorkspace();
        if (restored) {
            tabs = restored.tabs.map((tab) => ({ ...tab, model: monaco.editor.createModel(tab.content, 'markdown', monaco.Uri.parse(`inmemory://markdown-studio/${tab.id}.md`)) }));
            activeTabId = null;
            switchTab(restored.activeTabId, false);
            return;
        }

        const legacyContent = loadLastContent();
        const firstTab = createTab({
            title: 'Markdown syntax guide',
            content: typeof legacyContent === 'string' ? legacyContent : defaultInput
        });
        activeTabId = null;
        switchTab(firstTab.id, false);
    };

    const setupSidebar = () => {
        const workspace = document.querySelector('#workspace');
        const toggle = document.querySelector('#sidebar-toggle');
        const newTabButton = document.querySelector('#new-tab-button');
        const saved = Storehouse.getItem(localStorageNamespace, localStorageSidebarKey);
        const setCollapsed = (collapsed) => {
            workspace.classList.toggle('sidebar-collapsed', collapsed);
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
            toggle.setAttribute('title', `${collapsed ? 'Expand' : 'Collapse'} sidebar (⌘/Ctrl+B)`);
            Storehouse.setItem(localStorageNamespace, localStorageSidebarKey, collapsed, new Date(2099, 1, 1));
            setTimeout(() => editor.layout(), 240);
        };
        setCollapsed(saved === true || saved === 'true');
        toggle.addEventListener('click', () => setCollapsed(!workspace.classList.contains('sidebar-collapsed')));
        newTabButton.addEventListener('click', () => addNewTab());

        document.addEventListener('keydown', (event) => {
            const modifier = event.metaKey || event.ctrlKey;
            if (modifier && event.shiftKey && event.key.toLowerCase() === 'n') {
                event.preventDefault();
                addNewTab();
            }
            if (modifier && event.key.toLowerCase() === 'b') {
                event.preventDefault();
                setCollapsed(!workspace.classList.contains('sidebar-collapsed'));
            }
            if (modifier && event.key.toLowerCase() === 'w' && !event.shiftKey) {
                event.preventDefault();
                closeTab(activeTabId);
            }
        });
    };

    // Reset input text
    let reset = () => {
        let changed = editor.getValue() != defaultInput;
        if (hasEdited || changed) {
            var confirmed = window.confirm(confirmationMessage);
            if (!confirmed) {
                return;
            }
        }
        presetValue(defaultInput);
        document.querySelectorAll('.column').forEach((element) => {
            element.scrollTo({ top: 0 });
        });
    };

    let presetValue = (value) => {
        editor.setValue(value);
        editor.revealPosition({ lineNumber: 1, column: 1 });
        editor.focus();
        hasEdited = false;
    };

    // ----- sync scroll position -----

    let initScrollBarSync = (settings) => {
        let checkbox = document.querySelector('#sync-scroll-checkbox');
        checkbox.checked = settings;
        scrollBarSync = settings;

        checkbox.addEventListener('change', (event) => {
            let checked = event.currentTarget.checked;
            scrollBarSync = checked;
            saveScrollBarSettings(checked);
        });
    };

    // ----- preview CSS loader (switch github-markdown css) -----
    const PREVIEW_CSS_LIGHT = 'css/github-markdown-light.css?v=a1a198514565';
    const PREVIEW_CSS_DARK = 'css/github-markdown-dark_dimmed.css?v=5d3f5d9d207c';

    let setPreviewCss = (useDark) => {
        const link = document.getElementById('gh-markdown-link');
        const desired = useDark ? PREVIEW_CSS_DARK : PREVIEW_CSS_LIGHT;
        if (!link) {
            const newLink = document.createElement('link');
            newLink.id = 'gh-markdown-link';
            newLink.rel = 'stylesheet';
            newLink.href = desired;
            document.head.appendChild(newLink);
            return new Promise((resolve) => {
                newLink.addEventListener('load', resolve, { once: true });
                newLink.addEventListener('error', resolve, { once: true });
            });
        }

        if (link.getAttribute('href') === desired) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', resolve, { once: true });
            link.setAttribute('href', desired);
        });
    };

    // ----- theme toggle (dark/light) -----
    let setTheme = (enabled) => {
        document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
    };

    let initThemeToggle = (settings) => {
        let checkbox = document.querySelector('#theme-checkbox');
        if (!checkbox) return;
        checkbox.checked = settings;
        setTheme(settings);

        // set Monaco editor theme to match page theme
        if (monaco && monaco.editor && typeof monaco.editor.setTheme === 'function') {
            monaco.editor.setTheme(settings ? 'vs-dark' : 'vs');
        }
        // set preview css to match theme
        setPreviewCss(settings);

        checkbox.addEventListener('change', (event) => {
            let checked = event.currentTarget.checked;
            setTheme(checked);
            saveThemeSettings(checked);
            setPreviewCss(checked);
            if (monaco && monaco.editor && typeof monaco.editor.setTheme === 'function') {
                monaco.editor.setTheme(checked ? 'vs-dark' : 'vs');
            }
            renderMermaidDiagrams();
        });
    };

    let enableScrollBarSync = () => {
        scrollBarSync = true;
    };

    let disableScrollBarSync = () => {
        scrollBarSync = false;
    };

    // ----- clipboard utils -----

    let copyToClipboard = (text, successHandler, errorHandler) => {
        navigator.clipboard.writeText(text).then(
            () => {
                successHandler();
            },

            () => {
                errorHandler();
            }
        );
    };

    let notifyCopied = () => {
        let labelElement = document.querySelector("#copy-button a");
        labelElement.textContent = "Copied!";
        setTimeout(() => {
            labelElement.textContent = "Copy";
        }, 1000)
    };

    // ----- export preview -----

    let restoreMermaidThemeAfterPrint = (theme) => {
        const printMedia = window.matchMedia('print');
        let printSessionStarted = false;

        const cleanup = () => {
            printMedia.removeEventListener('change', handlePrintMediaChange);
        };

        const handlePrintMediaChange = (event) => {
            if (event.matches) {
                printSessionStarted = true;
                return;
            }

            if (!printSessionStarted) {
                return;
            }

            cleanup();
            renderMermaidDiagrams(theme);
        };

        printMedia.addEventListener('change', handlePrintMediaChange);
        return cleanup;
    };

    let exportPreviewToPdf = () => {
        const currentTheme = getMermaidTheme();
        const printTheme = 'default';

        const cleanupPrintThemeListener = currentTheme === 'dark'
            ? restoreMermaidThemeAfterPrint(currentTheme)
            : null;

        renderMermaidDiagrams(printTheme).then(() => {
            window.print();
        }).catch((error) => {
            // eslint-disable-next-line no-console
            console.error('Failed to prepare PDF export', error);
            if (currentTheme === 'dark') {
                cleanupPrintThemeListener();
                renderMermaidDiagrams(currentTheme);
            }
            window.alert('Unable to prepare the print preview. Please try again.');
        });
    };

    // ----- setup -----

    // setup navigation actions
    let setupOpenButton = () => {
        const button = document.querySelector('#open-button');
        const input = document.querySelector('#open-file-input');

        button.addEventListener('click', () => {
            input.click();
        });

        input.addEventListener('change', async () => {
            const file = input.files[0];
            // Allow the same file to be selected again, including after a failed read.
            input.value = '';
            if (!file) return;

            button.disabled = true;
            let content;
            try {
                content = await file.text();
            } catch (error) {
                window.alert('Unable to read this file. Please try again.');
                return;
            } finally {
                button.disabled = false;
            }

            const title = file.name.replace(/\.(md|markdown)$/i, '') || 'Imported document';
            addNewTab({ title, content, rename: false });
        });
    };

    let setupResetButton = () => {
        document.querySelector("#reset-button").addEventListener('click', (event) => {
            event.preventDefault();
            reset();
        });
    };

    let setupCopyButton = (editor) => {
        document.querySelector("#copy-button").addEventListener('click', (event) => {
            event.preventDefault();
            let value = editor.getValue();
            copyToClipboard(value, () => {
                notifyCopied();
            },
                () => {
                    // nothing to do
                });
        });
    };

    let setupExportButton = () => {
        const exportButton = document.querySelector('#export-button');
        if (!exportButton) {
            return;
        }
        exportButton.addEventListener('click', (event) => {
            event.preventDefault();
            exportPreviewToPdf();
        });
    };

    // ----- local state -----

    let loadLastContent = () => {
        let lastContent = Storehouse.getItem(localStorageNamespace, localStorageKey);
        return lastContent;
    };

    let saveLastContent = (content) => {
        let expiredAt = new Date(2099, 1, 1);
        Storehouse.setItem(localStorageNamespace, localStorageKey, content, expiredAt);
    };

    let loadScrollBarSettings = () => {
        let lastContent = Storehouse.getItem(localStorageNamespace, localStorageScrollBarKey);
        return lastContent;
    };

    let loadThemeSettings = () => {
        let last = Storehouse.getItem(localStorageNamespace, localStorageThemeKey);
        if (last === null || last === undefined) {
            try {
                // fallback to raw localStorage boot key used by inline script
                const raw = localStorage.getItem('com.markdownlivepreview_theme');
                if (raw === 'dark') return true;
                if (raw === 'light') return false;
            } catch (e) {
                // ignore
            }
        }
        return last;
    };

    let saveScrollBarSettings = (settings) => {
        let expiredAt = new Date(2099, 1, 1);
        Storehouse.setItem(localStorageNamespace, localStorageScrollBarKey, settings, expiredAt);
    };

    let saveThemeSettings = (settings) => {
        let expiredAt = new Date(2099, 1, 1);
        Storehouse.setItem(localStorageNamespace, localStorageThemeKey, settings, expiredAt);
        try {
            localStorage.setItem('com.markdownlivepreview_theme', settings ? 'dark' : 'light');
        } catch (e) {
            // ignore storage errors
        }
    };

    let setupDivider = () => {
        let lastLeftRatio = 0.5;
        const divider = document.getElementById('split-divider');
        const leftPane = document.getElementById('edit');
        const rightPane = document.getElementById('preview');
        const container = document.getElementById('document-split');

        let isDragging = false;

        divider.addEventListener('mouseenter', () => {
            divider.classList.add('hover');
        });

        divider.addEventListener('mouseleave', () => {
            if (!isDragging) {
                divider.classList.remove('hover');
            }
        });

        divider.addEventListener('mousedown', () => {
            isDragging = true;
            divider.classList.add('active');
            document.body.style.cursor = 'col-resize';
        });

        divider.addEventListener('dblclick', () => {
            const containerRect = container.getBoundingClientRect();
            const totalWidth = containerRect.width;
            const dividerWidth = divider.offsetWidth;
            const halfWidth = (totalWidth - dividerWidth) / 2;

            leftPane.style.width = halfWidth + 'px';
            rightPane.style.width = halfWidth + 'px';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            document.body.style.userSelect = 'none';
            const containerRect = container.getBoundingClientRect();
            const totalWidth = containerRect.width;
            const offsetX = e.clientX - containerRect.left;
            const dividerWidth = divider.offsetWidth;

            // Prevent overlap or out-of-bounds
            const minWidth = 100;
            const maxWidth = totalWidth - minWidth - dividerWidth;
            const leftWidth = Math.max(minWidth, Math.min(offsetX, maxWidth));
            leftPane.style.width = leftWidth + 'px';
            rightPane.style.width = (totalWidth - leftWidth - dividerWidth) + 'px';
            lastLeftRatio = leftWidth / (totalWidth - dividerWidth);
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                divider.classList.remove('active');
                divider.classList.remove('hover');
                document.body.style.cursor = 'default';
                document.body.style.userSelect = '';
            }
        });

        window.addEventListener('resize', () => {
            const containerRect = container.getBoundingClientRect();
            const totalWidth = containerRect.width;
            const dividerWidth = divider.offsetWidth;
            const availableWidth = totalWidth - dividerWidth;

            const newLeft = availableWidth * lastLeftRatio;
            const newRight = availableWidth * (1 - lastLeftRatio);

            leftPane.style.width = newLeft + 'px';
            rightPane.style.width = newRight + 'px';
        });
    };

    // ----- entry point -----
    editor = setupEditor();
    setupWorkspace();
    setupSidebar();
    window.setInterval(updateDocumentBar, 30_000);
    setupOpenButton();
    setupResetButton();
    setupCopyButton(editor);
    setupExportButton();

    let scrollBarSettings = loadScrollBarSettings() || false;
    initScrollBarSync(scrollBarSettings);

    // initialize theme (dark/light)
    let themeSettings = loadThemeSettings();
    // normalize to boolean (Storehouse may return string or boolean)
    if (themeSettings === 'true' || themeSettings === true) {
        themeSettings = true;
    } else {
        themeSettings = false;
    }
    initThemeToggle(themeSettings);

    setupDivider();
};

window.addEventListener("load", () => {
    init();
});
