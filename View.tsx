import { ItemView, WorkspaceLeaf, TFile, ButtonComponent, Notice } from "obsidian";
import SpacedRepetitionPlugin from "./main";

export const VIEW_TYPE_REVIEW = "review-view";

export class ReviewView extends ItemView {
    plugin: SpacedRepetitionPlugin;
    hardFiles: Set<string> = new Set();
    calendarOffset: number = 0;
    selectedDate: string | null = null; 
    currentQueue: TFile[] = []; 

    constructor(leaf: WorkspaceLeaf, plugin: SpacedRepetitionPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE_REVIEW; }
    getDisplayText() { return "Review Calendar"; }

    async onOpen() { this.refreshUI(); }

    markAsHard(file: TFile) {
        this.hardFiles.add(file.path);
        this.refreshListOnly();
    }

    // --- LOGIC: SWITCH OR CLOSE ---
    async openNext() {
        // 1. Get the Active Leaf (usually the note you just edited)
        const activeLeaf = this.app.workspace.getLeaf(false);
        
        // Safety: Check if we are accidentally targeting the Review View itself
        if (activeLeaf.view.getViewType() === VIEW_TYPE_REVIEW) {
            // Try to find a markdown leaf instead
            const markdownLeaf = this.app.workspace.getLeavesOfType("markdown")[0];
            if (!markdownLeaf) return; // No note open to switch/close
            // Use that leaf instead
            this.processQueueAction(markdownLeaf);
        } else {
            this.processQueueAction(activeLeaf);
        }
    }

    async processQueueAction(leaf: WorkspaceLeaf) {
        if (this.currentQueue.length > 0) {
            // --- QUEUE HAS ITEMS: SWITCH NOTE ---
            const nextFile = this.currentQueue[0];
            
            // Get the file currently in the leaf
            const currentFile = (leaf.view as any).file;

            // Only open if it's actually a different file (prevents reload loop on single Hard card)
            if (!currentFile || currentFile.path !== nextFile.path) {
                await leaf.openFile(nextFile);
                this.plugin.startReviewSession(nextFile);
            }
        } else {
            // --- QUEUE EMPTY: CLOSE NOTE ---
            new Notice("🎉 Session Complete!");
            // Detach (Close) the leaf to clean up workspace
            leaf.detach();
        }
    }
    // -----------------------------

    async refreshUI() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('srs-container');

        // HEADER
        const headerDiv = container.createDiv({ cls: 'srs-header-controls' });
        headerDiv.createEl("h3", { text: "Review Calendar", style: "margin:0;" });
        new ButtonComponent(headerDiv).setIcon('reset').setTooltip('Refresh').onClick(() => {
            this.hardFiles.clear();
            this.selectedDate = null;
            this.refreshUI();
        });

        // CALENDAR
        const calendarContainer = container.createDiv({ cls: 'srs-calendar' });
        this.renderCalendar(calendarContainer);

        // TITLE
        const titleContainer = container.createDiv({ cls: 'srs-list-header' });
        if (this.selectedDate) {
            titleContainer.createEl("h3", { text: `Reviews for ${this.selectedDate}` });
            new ButtonComponent(titleContainer).setButtonText("Clear Filter").onClick(() => {
                this.selectedDate = null; this.refreshUI();
            });
        } else {
            titleContainer.createEl("h3", { text: "Due Now" });
        }

        // LIST
        const listContainer = container.createDiv({ cls: 'srs-list-area' });
        await this.renderList(listContainer);
    }

    async refreshListOnly() {
        const listArea = this.containerEl.querySelector('.srs-list-area');
        if (listArea) {
            listArea.empty();
            await this.renderList(listArea as HTMLElement);
        }
    }

    refreshCalendar() {
        const calendarArea = this.containerEl.querySelector('.srs-calendar');
        if (calendarArea) {
            calendarArea.empty();
            this.renderCalendar(calendarArea as HTMLElement);
        }
    }

    renderCalendar(container: HTMLElement) {
        const today = window.moment().startOf('day');
        const displayMonth = window.moment().add(this.calendarOffset, 'months');
        const startOfMonth = displayMonth.clone().startOf('month');
        const endOfMonth = displayMonth.clone().endOf('month');

        const header = container.createDiv({ cls: 'calendar-header' });
        new ButtonComponent(header).setIcon('arrow-left').setClass('calendar-nav-btn')
            .onClick(() => { this.calendarOffset--; this.refreshCalendar(); });
        header.createSpan({ cls: 'calendar-title', text: displayMonth.format("MMMM YYYY") });
        new ButtonComponent(header).setIcon('arrow-right').setClass('calendar-nav-btn')
            .onClick(() => { this.calendarOffset++; this.refreshCalendar(); });

        const grid = container.createDiv({ cls: 'calendar-grid' });
        ['S','M','T','W','T','F','S'].forEach(d => grid.createDiv({ cls: 'calendar-day-name', text: d }));
        for (let i = 0; i < startOfMonth.day(); i++) grid.createDiv({ cls: 'calendar-cell empty' });

        const futureCounts: {[date: string]: number} = {};
        this.app.vault.getMarkdownFiles().forEach(f => {
            if(!f.path.startsWith(this.plugin.settings.targetFolder)) return;
            const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
            if(fm && fm.anki_due) {
                const dateKey = window.moment(fm.anki_due).format("YYYY-MM-DD");
                futureCounts[dateKey] = (futureCounts[dateKey] || 0) + 1;
            }
        });

        const current = startOfMonth.clone();
        while (current.isSameOrBefore(endOfMonth)) {
            const dateStr = current.format("YYYY-MM-DD");
            const cell = grid.createDiv({ cls: 'calendar-cell' });
            
            cell.addEventListener('click', () => {
                this.selectedDate = dateStr;
                this.refreshListOnly();
                this.refreshCalendar(); 
            });

            if (this.selectedDate === dateStr) cell.addClass('is-selected');
            if (current.isSame(today, 'day')) cell.addClass('is-today');

            cell.createDiv({ cls: 'day-number', text: current.format("D") });

            if (current.isBefore(today, 'day')) {
                const reviews = this.plugin.settings.reviewHistory[dateStr] || 0;
                if (reviews > 0) {
                    cell.style.backgroundColor = `rgba(76, 175, 80, ${Math.min(0.2 + (reviews / 5), 1)})`;
                }
            } else {
                const dueCount = futureCounts[dateStr] || 0;
                const badge = cell.createDiv({ cls: 'future-badge', text: dueCount.toString() });
                if (dueCount > 0) badge.addClass('has-dues');
                else badge.addClass('zero-dues');
            }
            current.add(1, 'day');
        }
    }

    async renderList(container: HTMLElement) {
        const allFiles = this.app.vault.getMarkdownFiles();
        const now = new Date();
        const todayEnd = window.moment().endOf('day').toDate();
        let dueFiles: TFile[] = [];

        // 1. FILTERING
        for (const file of allFiles) {
            if (!file.path.startsWith(this.plugin.settings.targetFolder)) continue;
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (!fm || !fm.anki_due) continue;
            
            const dueDate = new Date(fm.anki_due);
            const dueMoment = window.moment(dueDate);

            if (this.selectedDate) {
                if (dueMoment.format("YYYY-MM-DD") === this.selectedDate) dueFiles.push(file);
            } else {
                if (dueDate <= todayEnd) dueFiles.push(file);
            }
        }

        // 2. SORTING
        dueFiles.sort((a, b) => {
            const aD = new Date(this.app.metadataCache.getFileCache(a)?.frontmatter?.anki_due || 0).getTime();
            const bD = new Date(this.app.metadataCache.getFileCache(b)?.frontmatter?.anki_due || 0).getTime();
            return aD - bD;
        });

        this.currentQueue = dueFiles;

        if (dueFiles.length === 0) {
            container.createEl("div", { cls: "srs-empty-state", text: "No cards found." });
            return;
        }

        const ul = container.createEl("ul", { cls: 'srs-link-list' });

        // Count strictly due (Used to check if we can skip waiting)
        const readyCount = dueFiles.filter(f => {
            const d = new Date(this.app.metadataCache.getFileCache(f)?.frontmatter?.anki_due || 0);
            return d <= now;
        }).length;

        const isFuturePreview = this.selectedDate && this.selectedDate !== window.moment().format("YYYY-MM-DD");

        for (let i = 0; i < dueFiles.length; i++) {
            const file = dueFiles[i];
            const li = ul.createEl("li");
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            
            const state = fm?.State || 'New';
            const created = fm?.Created ? window.moment(fm.Created).format("MM/DD/YYYY") : "";
            const tags = fm?.tags || [];
            const dueTime = window.moment(fm?.anki_due);
            const isStrictlyDue = dueTime.toDate() <= now;

            // --- STACK LOGIC ---
            let isDisabled = false;
            let showTimer = false;

            if (isFuturePreview) {
                isDisabled = true;
                showTimer = true;
            } else {
                if (i === 0) {
                    // TOP CARD
                    if (isStrictlyDue) {
                        isDisabled = false;
                        showTimer = false;
                    } else {
                        // WAITING (e.g. 10m Hard)
                        // Unlock IF this is the only thing stopping us
                        if (readyCount === 0) {
                            isDisabled = false; 
                            showTimer = false; // Hide timer so it looks like a normal review
                        } else {
                            isDisabled = true;
                            showTimer = true;
                        }
                    }
                } else {
                    // NOT Top Card
                    isDisabled = true;
                    showTimer = true;
                }
            }

            if (isDisabled) li.addClass("is-disabled");

            const left = li.createDiv({cls: 'srs-item-left'});
            const link = left.createEl("a", { text: file.basename, cls: 'internal-link' });
            
            if (!isDisabled) {
                link.addEventListener("click", async () => {
                    await this.plugin.startReviewSession(file);
                    this.app.workspace.getLeaf(false).openFile(file);
                });
            }

            const metaRow = left.createDiv({cls: 'srs-meta-row'});
            tags.forEach((t: string) => {
                if (!t.startsWith('srs/')) metaRow.createSpan({ cls: 'tag-pill', text: t });
            });
            if (created) metaRow.createSpan({ cls: 'meta-date', text: `📅 ${created}` });

            const right = li.createDiv({cls: 'srs-item-right'});
            right.createSpan({ cls: `state-pill is-${String(state).toLowerCase()}`, text: state });

            if (showTimer) {
                 right.createSpan({ cls: 'time-pill', text: dueTime.fromNow(true) });
            }
        }
    }
}
