import { CommonModule } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FsLightbox } from 'fslightbox-angular/16-19';
import { AccessRole, GalleryPhoto, LoveVaultService, UploadPhotoInput } from './love-vault.service';
import { looksLikeImageFile, normalizePhotoBlob } from './photo-normalizer';

interface SelectedUploadPreview {
  id: string;
  fileName: string;
  previewSrc: string | null;
  upload: UploadPhotoInput;
  wasHeicConverted: boolean;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, FsLightbox],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnDestroy {
  readonly vault = inject(LoveVaultService);
  readonly authMode = signal<'sign-in' | 'sign-up'>('sign-in');
  readonly feedback = signal<{ text: string; tone: 'error' | 'info' | 'success' } | null>(null);
  readonly currentUser = computed(() => this.vault.currentUser());
  readonly currentRole = computed(() => this.vault.currentRole());
  readonly isOwner = computed(() => this.currentRole() === 'owner');
  readonly photos = computed(() => this.vault.photos());
  readonly totalPhotos = computed(() => this.photos().length);
  readonly preparingUploads = signal(false);
  readonly savingUploads = signal(false);
  readonly selectedPhotoId = signal<string | null>(null);
  readonly selectedPhoto = computed(
    () => {
      const found = this.photos().find((photo) => photo.id === this.selectedPhotoId()) ?? null;
      console.log('selectedPhoto computed:', found);
      return found;
    }
  );

  confirmPassword = '';
  email = '';
  password = '';
  photoCaption = '';
  selectedUploads: SelectedUploadPreview[] = [];

  // Add lightbox state for fslightbox-angular
  lightboxOpen = false;
  selectedPhotoIndex = 1;

  ngOnDestroy(): void {
    this.clearSelectedUploads();
  }

  setAuthMode(mode: 'sign-in' | 'sign-up'): void {
    this.authMode.set(mode);
    this.password = '';
    this.confirmPassword = '';
    this.feedback.set(null);
  }

  async submitAuth(): Promise<void> {
    if (this.authMode() === 'sign-up') {
      await this.signUp();
      return;
    }

    await this.signIn();
  }

  async signIn(): Promise<void> {
    const success = await this.vault.signIn(this.email, this.password);

    if (!success) {
      this.feedback.set({
        text: this.vault.errorMessage() || 'I could not sign you in.',
        tone: 'error'
      });
      return;
    }

    this.password = '';
    this.confirmPassword = '';
    this.feedback.set({
      text: 'Signed in successfully.',
      tone: 'success'
    });
  }

  async signUp(): Promise<void> {
    if (this.password.length < 6) {
      this.feedback.set({
        text: 'Use at least 6 characters for the password.',
        tone: 'error'
      });
      return;
    }

    if (this.password !== this.confirmPassword) {
      this.feedback.set({
        text: 'The password fields do not match.',
        tone: 'error'
      });
      return;
    }

    const result = await this.vault.signUp(this.email, this.password);

    if (!result.success) {
      this.feedback.set({
        text: this.vault.errorMessage() || 'I could not create the account.',
        tone: 'error'
      });
      return;
    }

    this.password = '';
    this.confirmPassword = '';
    this.feedback.set({
      text: result.requiresEmailConfirmation
        ? 'Account created. Confirm the email, then sign in.'
        : 'Account created and signed in.',
      tone: 'success'
    });
  }

  async signOut(): Promise<void> {
    this.closePhoto();
    this.clearSelectedUploads();
    await this.vault.signOut();
    this.feedback.set({
      text: 'Signed out of the gallery.',
      tone: 'info'
    });
  }

  async onFilesChosen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const chosenFiles = Array.from(input?.files ?? []);
    this.clearSelectedUploads();

    if (!chosenFiles.length) {
      this.feedback.set(null);
      return;
    }

    const supportedFiles = chosenFiles.filter((file) => this.looksLikeImage(file));

    if (!supportedFiles.length) {
      this.feedback.set({
        text: 'Those files are not supported image types.',
        tone: 'error'
      });
      return;
    }

    this.preparingUploads.set(true);
    this.feedback.set({
      text: 'Preparing the selected photos.',
      tone: 'info'
    });

    try {
      const preparedResults = await Promise.allSettled(
        supportedFiles.map((file) => this.prepareUploadPreview(file))
      );

      this.selectedUploads = preparedResults
        .filter((result): result is PromiseFulfilledResult<SelectedUploadPreview> => result.status === 'fulfilled')
        .map((result) => result.value);

      if (!this.selectedUploads.length) {
        throw new Error('No images could be prepared.');
      }

      const convertedCount = this.selectedUploads.filter((upload) => upload.wasHeicConverted).length;
      const convertedText = convertedCount
        ? ` ${convertedCount} HEIC photo${convertedCount === 1 ? ' was' : 's were'} converted for preview.`
        : '';

      this.feedback.set({
        text: `${this.selectedUploads.length} photo${this.selectedUploads.length === 1 ? '' : 's'} ready to upload.${convertedText}`,
        tone: 'info'
      });
    } catch {
      this.clearSelectedUploads();
      this.feedback.set({
        text: 'The selected photos could not be prepared in this browser.',
        tone: 'error'
      });
    } finally {
      this.preparingUploads.set(false);
    }
  }

  async saveSelectedPhotos(fileInput: HTMLInputElement): Promise<void> {
    if (!this.selectedUploads.length) {
      this.feedback.set({
        text: 'Choose one or more photos first.',
        tone: 'error'
      });
      return;
    }

    this.savingUploads.set(true);
    this.feedback.set({
      text: 'Uploading the private gallery photos.',
      tone: 'info'
    });

    try {
      const saved = await this.vault.saveFiles(
        this.selectedUploads.map((entry) => entry.upload),
        this.photoCaption
      );

      if (!saved) {
        this.feedback.set({
          text: this.vault.errorMessage() || 'I could not upload those photos.',
          tone: 'error'
        });
        return;
      }

      this.clearSelectedUploads();
      this.photoCaption = '';
      fileInput.value = '';
      this.feedback.set({
        text: 'The private gallery was updated.',
        tone: 'success'
      });
    } finally {
      this.savingUploads.set(false);
    }
  }

  async removePhoto(photo: GalleryPhoto): Promise<void> {
    if (!window.confirm(`Delete "${photo.fileName}" from the gallery?`)) {
      return;
    }

    const removed = await this.vault.removePhoto(photo);

    if (!removed) {
      this.feedback.set({
        text: this.vault.errorMessage() || 'I could not delete that photo.',
        tone: 'error'
      });
      return;
    }

    if (this.selectedPhotoId() === photo.id) {
      this.selectedPhotoId.set(null);
    }

    this.feedback.set({
      text: 'The photo was deleted from the gallery.',
      tone: 'info'
    });
  }

  resetPickerValue(event: Event): void {
    const input = event.target as HTMLInputElement | null;

    if (input) {
      input.value = '';
    }
  }

  openPhoto(id: string): void {
    const index = this.photos().findIndex((photo) => photo.id === id);
    if (index !== -1) {
      this.selectedPhotoIndex = index + 1; // fslightbox is 1-based
      this.lightboxOpen = !this.lightboxOpen; // toggler must change value to open
    }
    this.selectedPhotoId.set(id);
  }

  closePhoto(): void {
    this.lightboxOpen = false;
    this.selectedPhotoId.set(null);
  }

  private romanticCaptions = [
    '✨ Every moment with you feels like a beautiful dream I never want to wake from.',
    '💕 You are my favorite hello and my hardest goodbye.',
    '🌹 In your smile, I found my home, my peace, and my forever.',
    '💫 When I look into your eyes, I see our entire future written in the stars.',
    '❤️ With you, I have found my greatest love and my truest friend.',
    '🌸 You make my heart skip a beat every single day.',
    '💖 My heart chose you before my mind could catch up.',
    '✨ You are the answer to every prayer I never knew I was praying.',
    '🎀 Every frame captures a moment of pure magic with you.',
    '💝 You are my today and all of my tomorrows.',
    '🌙 Even the stars are jealous of how beautifully we shine together.',
    '🦋 You make me believe in love at first sight, every single time.',
    '💐 Being with you is like finding a piece of my soul I didn\'t know was missing.',
    '✨ You\'re not just my love, you\'re my adventure, my peace, my home.',
    '❤️‍🔥 Forever feels like the right amount of time to love someone like you.',
    '🌺 In this moment, with you, I found everything I\'ve been searching for.',
    '💕 Your love has made me the happiest version of myself.',
    '🌟 You are my greatest blessing and my sweetest dream come true.',
    '🎆 Together, we create magic that the world has never seen before.',
    '💘 I fall in love with you more and more with each passing day.'
  ];

  formatPhotoTitle(photo: GalleryPhoto): string {
    const caption = photo.caption.trim();

    if (caption) {
      return caption;
    }

    const withoutExtension = photo.fileName.replace(/\.[^.]+$/, '');
    const normalized = withoutExtension
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return 'Our special memory';
    }

    return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
  }

  getPhotoCaption(photo: GalleryPhoto): string {
    const dbCaption = photo.caption?.trim();
    if (dbCaption) {
      return dbCaption;
    }
    // Use photo ID or index to consistently assign romantic captions
    const photoId = photo.id;
    const hashCode = photoId.split('').reduce((acc, char) => {
      return ((acc << 5) - acc) + char.charCodeAt(0);
    }, 0);
    const index = Math.abs(hashCode) % this.romanticCaptions.length;
    return this.romanticCaptions[index];
  }

  private looksLikeImage(file: File): boolean {
    return looksLikeImageFile(file.name, file.type);
  }

  private async prepareUploadPreview(file: File): Promise<SelectedUploadPreview> {
    const previewId = crypto.randomUUID();

    if (this.looksLikeHeic(file)) {
      const prepared = await normalizePhotoBlob(file, file.name, { optimize: false });

      return {
        fileName: prepared.fileName,
        id: previewId,
        previewSrc: URL.createObjectURL(prepared.blob),
        upload: {
          blob: file,
          fileName: file.name
        },
        wasHeicConverted: prepared.wasHeicConverted
      };
    }

    return {
      fileName: file.name,
      id: previewId,
      previewSrc: URL.createObjectURL(file),
      upload: {
        blob: file,
        fileName: file.name
      },
      wasHeicConverted: false
    };
  }

  private looksLikeHeic(file: File): boolean {
    return /(\.heic|\.heif)$/i.test(file.name) || /image\/hei(c|f)/i.test(file.type);
  }

  private clearSelectedUploads(): void {
    for (const upload of this.selectedUploads) {
      if (upload.previewSrc) {
        URL.revokeObjectURL(upload.previewSrc);
      }
    }

    this.selectedUploads = [];
  }

  isMobile(): boolean {
    return window.innerWidth <= 680;
  }
}
