import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { ReviewView, VIEW_TYPE_REVIEW } from './View';
import { AnkiScheduler, Card, Rating } from './sr-algorithm';

interface PluginSettings {
    targetFolder: string;
    reviewHistory: { [date: string]: number };
}

const DEFAULT_SETTINGS: PluginSettings = {
    targetFolder: 'Study Notes',
    reviewHistory: {}
};

export default class SpacedRepetitionPlugin extends Plugin {
    settings: PluginSettings;
    view: ReviewView;
    scheduler: AnkiScheduler;

    async onload() {
        await this.loadSettings();
        this.scheduler = new AnkiScheduler();

        this.addSettingTab(new SpacedRepetitionSettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE_REVIEW,
            (leaf) => (this.view = new ReviewView(leaf, this))
        );

        this.addRibbonIcon('calendar-check', 'Open Review List', () => {
            this.activateView();
        });

        // Commands
        this.addCommand({ id: 'rate-again', name: 'Rate: Again', callback: () => this.rateActiveNote('Again') });
        this.addCommand({ id: 'rate-hard', name: 'Rate: Hard', callback: () => this.rateActiveNote('Hard') });
        this.addCommand({ id: 'rate-good', name: 'Rate: Good', callback: () => this.rateActiveNote('Good') });
        this.addCommand({ id: 'rate-easy', name: 'Rate: Easy', callback: () => this.rateActiveNote('Easy') });

        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile && file.path.startsWith(this.settings.targetFolder)) {
                this.initFile(file);
            }
        }));

        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            this.handleMetadataChange(file);
        }));
    }

    async handleMetadataChange(file: TFile) {
        if (!file.path.startsWith(this.settings.targetFolder)) return;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm || !fm.State) return;

        let stateValue = "";
        if (Array.isArray(fm.State)) {
            stateValue = fm.State[0] ? String(fm.State[0]).toLowerCase() : "";
        } else {
            stateValue = String(fm.State).toLowerCase();
        }

        let rating: Rating | null = null;
        if (stateValue === 'again' || stateValue === 'fail') rating = 'Again';
        else if (stateValue === 'hard') rating = 'Hard';
        else if (stateValue === 'good' || stateValue === 'medium') rating = 'Good';
        else if (stateValue === 'easy') rating = 'Easy';

        if (rating) {
            await this.processReview(file, rating);
        }
    }

    async rateActiveNote(rating: Rating) {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        await this.processReview(file, rating);
    }

    async startReviewSession(file: TFile) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (fm && (fm.State === 'New' || !fm.State)) {
             await this.app.fileManager.processFrontMatter(file, (editFm) => {
                editFm['State'] = 'Learning';
                editFm['anki_hidden_state'] = 'Learning';
                if (!editFm['anki_due']) editFm['anki_due'] = new Date().toISOString();
                editFm['anki_interval'] = 0;
                editFm['anki_step'] = 0;
            });
            if (this.view) this.view.refreshListOnly();
        }
    }

    async processReview(file: TFile, rating: Rating) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const card: Card = {
                id: file.path,
                state: this.isValidState(fm['anki_hidden_state']) ? fm['anki_hidden_state'] : 'Review',
                interval: fm['anki_interval'] || 0,
                easeFactor: fm['anki_ease'] || 2.5,
                stepIndex: fm['anki_step'] || 0,
                dueDate: fm['anki_due'] ? new Date(fm['anki_due']) : new Date()
            };

            if (card.interval === 0 && card.stepIndex === 0 && card.state === 'Review') card.state = 'New';

            const nextCard = this.scheduler.schedule(card, rating);

            fm['State'] = nextCard.state; 
            fm['anki_hidden_state'] = nextCard.state; 
            fm['anki_interval'] = nextCard.interval;
            fm['anki_ease'] = nextCard.easeFactor;
            fm['anki_step'] = nextCard.stepIndex;
            fm['anki_due'] = nextCard.dueDate.toISOString();
        });

        if (rating !== 'Again') {
            const todayStr = window.moment().format("YYYY-MM-DD");
            this.settings.reviewHistory[todayStr] = (this.settings.reviewHistory[todayStr] || 0) + 1;
            await this.saveSettings();
        }

        new Notice(`Reviewed: ${rating}`);

        // --- AUTO-ADVANCE & CLOSE ---
        if (this.view) {
            await this.view.refreshUI(); // Resort
            
            // Short delay to allow file system write
            setTimeout(() => {
                this.view.openNext();
            }, 200);
        }
    }

    isValidState(state: string): boolean {
        return ['New', 'Learning', 'Review', 'Relearning'].includes(state);
    }

    async initFile(file: TFile) {
        setTimeout(async () => {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (!fm['State']) {
                    fm['State'] = 'New';
                    fm['anki_hidden_state'] = 'New';
                    fm['anki_due'] = new Date().toISOString();
                    fm['Created'] = window.moment().format("YYYY-MM-DD");
                }
                if (!fm['tags']) fm['tags'] = [];
            });
        }, 100);
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_REVIEW);
        if (leaves.length > 0) leaf = leaves[0];
        else {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
}

class SpacedRepetitionSettingTab extends PluginSettingTab {
    plugin: SpacedRepetitionPlugin;
    constructor(app: App, plugin: SpacedRepetitionPlugin) { super(app, plugin); this.plugin = plugin; }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl)
            .setName('Target Folder')
            .addText(text => text.setValue(this.plugin.settings.targetFolder)
                .onChange(async (value) => {
                    this.plugin.settings.targetFolder = value.replace(/\/$/, "");
                    await this.plugin.saveSettings();
                }));
    }
}
