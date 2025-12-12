/**
 * Anki SM-2 Scheduler Implementation
 * * This class implements the specific flavor of the SM-2 algorithm used by Anki.
 * It handles:
 * 1. Learning Phase: Fixed steps (e.g., 1min, 10min)
 * 2. Review Phase: Exponential scheduling based on Ease Factor
 * 3. Lapses: Reseting cards that are forgotten
 */

export type Rating = 'Again' | 'Hard' | 'Good' | 'Easy';
export type CardState = 'New' | 'Learning' | 'Review' | 'Relearning';

export interface Card {
    id: string;
    state: CardState;
    interval: number;       // In days (for Review) or minutes (for Learning)
    easeFactor: number;     // Multiplier (e.g., 2.5)
    stepIndex: number;      // Current step in the learning queue
    dueDate: Date;          // When the card should be shown next
}

export interface SchedulerSettings {
    learningSteps: number[];    // Default: [1, 10] (in minutes)
    graduatingInterval: number; // Default: 1 (in days)
    easyInterval: number;       // Default: 4 (in days)
    startingEase: number;       // Default: 2.5
    minEase: number;            // Default: 1.3
    easyBonus: number;          // Default: 1.3
    hardIntervalMultiplier: number; // Default: 1.2
}

export class AnkiScheduler {
    private settings: SchedulerSettings;

    constructor(settings?: Partial<SchedulerSettings>) {
        this.settings = {
            learningSteps: [1, 10], // 1 min, 10 min
            graduatingInterval: 1,  // 1 day
            easyInterval: 4,        // 4 days
            startingEase: 2.5,
            minEase: 1.3,
            easyBonus: 1.3,
            hardIntervalMultiplier: 1.2,
            ...settings
        };
    }

    /**
     * Calculates the next state, interval, and ease for a card based on the user's rating.
     */
    public schedule(card: Card, rating: Rating, now: Date = new Date()): Card {
        // Clone card to avoid mutating input directly
        const newCard = { ...card };
        
        if (newCard.state === 'New' || newCard.state === 'Learning') {
            this.handleLearning(newCard, rating, now);
        } else if (newCard.state === 'Review') {
            this.handleReview(newCard, rating, now);
        } else if (newCard.state === 'Relearning') {
            // Simplified relearning: treat similar to Learning but preserve Ease
            this.handleLearning(newCard, rating, now); 
        }

        return newCard;
    }

    /**
     * Handles logic for cards in the Learning queues (New/Learning/Relearning)
     */
    private handleLearning(card: Card, rating: Rating, now: Date): void {
        switch (rating) {
            case 'Again':
                // Reset to first step
                card.stepIndex = 0;
                this.setNextDueMinutes(card, this.settings.learningSteps[0], now);
                break;

            case 'Hard':
                // Repeat current step (no progress)
                // Note: In modern Anki, Hard during learning is avg of Again/Good, 
                // but standard SM-2 logic often treats it as "repeat step".
                this.setNextDueMinutes(card, this.settings.learningSteps[card.stepIndex], now);
                break;

            case 'Good':
                // Advance to next step
                if (card.stepIndex < this.settings.learningSteps.length - 1) {
                    card.stepIndex++;
                    this.setNextDueMinutes(card, this.settings.learningSteps[card.stepIndex], now);
                    card.state = 'Learning';
                } else {
                    // Graduate to Review
                    card.state = 'Review';
                    card.interval = this.settings.graduatingInterval;
                    card.easeFactor = card.easeFactor || this.settings.startingEase; // Ensure ease exists
                    this.setNextDueDays(card, card.interval, now);
                }
                break;

            case 'Easy':
                // Immediately graduate
                card.state = 'Review';
                card.interval = this.settings.easyInterval;
                card.easeFactor = card.easeFactor || this.settings.startingEase;
                this.setNextDueDays(card, card.interval, now);
                break;
        }
    }

    /**
     * Handles logic for cards in the exponential Review phase
     */
    private handleReview(card: Card, rating: Rating, now: Date): void {
        let newInterval = card.interval;
        let newEase = card.easeFactor;

        switch (rating) {
            case 'Again':
                // Fail: Reset interval, decrease ease
                // Note: Anki typically creates a "Lapse" phase here. 
                // For simplicity, we reset interval to 1 and reduce ease.
                card.state = 'Relearning';
                card.stepIndex = 0;
                newEase = Math.max(this.settings.minEase, newEase - 0.20);
                
                // Set immediate due date (10 min usually)
                this.setNextDueMinutes(card, this.settings.learningSteps[0], now);
                break;

            case 'Hard':
                // Pass, but difficult: Interval * 1.2, Ease decreases
                newInterval = Math.floor(newInterval * this.settings.hardIntervalMultiplier);
                newEase = Math.max(this.settings.minEase, newEase - 0.15);
                this.setNextDueDays(card, newInterval, now);
                break;

            case 'Good':
                // Standard Pass: Interval * Ease, Ease unchanged
                newInterval = Math.floor(newInterval * newEase);
                this.setNextDueDays(card, newInterval, now);
                break;

            case 'Easy':
                // Easy Pass: Interval * Ease * Bonus, Ease increases
                newInterval = Math.floor(newInterval * newEase * this.settings.easyBonus);
                newEase = newEase + 0.15; // Uncapped growth
                this.setNextDueDays(card, newInterval, now);
                break;
        }

        // Apply changes
        card.easeFactor = newEase;
        if (card.state === 'Review') {
            card.interval = newInterval;
        }
    }

    // Helper to add minutes to current time
    private setNextDueMinutes(card: Card, minutes: number, now: Date) {
        card.dueDate = new Date(now.getTime() + minutes * 60000);
    }

    // Helper to add days to current time
    private setNextDueDays(card: Card, days: number, now: Date) {
        const nextDate = new Date(now);
        nextDate.setDate(nextDate.getDate() + days);
        card.dueDate = nextDate;
    }
}
