import { CommonModule } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
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
  imports: [CommonModule, FormsModule],
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
    () => this.photos().find((photo) => photo.id === this.selectedPhotoId()) ?? null
  );

  confirmPassword = '';
  email = '';
  password = '';
  photoCaption = '';
  selectedUploads: SelectedUploadPreview[] = [];

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
    this.selectedPhotoId.set(id);
  }

  closePhoto(): void {
    this.selectedPhotoId.set(null);
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
}
