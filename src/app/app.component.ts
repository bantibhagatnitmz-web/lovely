import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Component, HostListener, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccessRole, GalleryPhoto, LoveVaultService, UploadPhotoInput } from './love-vault.service';
import { looksLikeImageFile, normalizePhotoBlob } from './photo-normalizer';

interface SelectedUploadPreview {
  id: string;
  fileName: string;
  previewSrc: string | null;
  upload: UploadPhotoInput;
  wasHeicConverted: boolean;
  soundtrackTitle: string;
  soundtrackLinkUrl: string;
}

interface SoundtrackOption {
  title: string;
  film: string;
  url: string;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnDestroy {
  readonly vault = inject(LoveVaultService);
  private readonly sanitizer = inject(DomSanitizer);
  readonly authMode = signal<'sign-in' | 'sign-up'>('sign-in');
  readonly feedback = signal<{ text: string; tone: 'error' | 'info' | 'success' } | null>(null);
  readonly currentUser = computed(() => this.vault.currentUser());
  readonly currentRole = computed(() => this.vault.currentRole());
  readonly isOwner = computed(() => this.currentRole() === 'owner');
  readonly photos = computed(() => this.vault.photos());
  readonly totalPhotos = computed(() => this.photos().length);
  readonly soundtrackOptions: SoundtrackOption[] = [
    { title: 'Tum Mile', film: 'Tum Mile', url: 'https://www.youtube.com/watch?v=odVptmgIcD0' },
    { title: 'Dil Ibaadat', film: 'Tum Mile', url: 'https://www.youtube.com/watch?v=d1h2xiBKVqE' },
    { title: 'Tu Hi Haqeeqat', film: 'Tum Mile', url: 'https://www.youtube.com/watch?v=7RZJCLb4g9A' },
    { title: 'Phir Mohabbat', film: 'Murder 2', url: 'https://www.youtube.com/watch?v=LC8Lln7-glM' },
    { title: 'Pee Loon', film: 'Once Upon a Time in Mumbaai', url: 'https://www.youtube.com/watch?v=D8XFTglfSMg' },
    { title: 'Teri Jhuki Nazar', film: 'Murder 3', url: 'https://www.youtube.com/watch?v=tGPhqvghCiQ' },
    { title: 'Zara Sa', film: 'Jannat', url: 'https://www.youtube.com/watch?v=As92mKxO3E4' }
  ];
  readonly preparingUploads = signal(false);
  readonly savingUploads = signal(false);
  readonly selectedPhotoId = signal<string | null>(null);
  readonly editingMusicPhotoId = signal<string | null>(null);
  readonly musicPlayerDragging = signal(false);
  readonly selectedPhoto = computed(
    () => {
      return this.photos().find((photo) => photo.id === this.selectedPhotoId()) ?? null;
    }
  );
  readonly editingMusicPhoto = computed(
    () => {
      return this.photos().find((photo) => photo.id === this.editingMusicPhotoId()) ?? null;
    }
  );

  confirmPassword = '';
  email = '';
  password = '';
  photoCaption = '';
  soundtrackTitle = this.soundtrackOptions[0].title;
  soundtrackLink = '';
  editMusicTitle = this.soundtrackOptions[0].title;
  editMusicLink = '';
  selectedUploads: SelectedUploadPreview[] = [];

  private previousBodyOverflow: string | null = null;
  private previousHtmlOverflow: string | null = null;
  private readonly youtubeEmbedUrlCache = new Map<string, SafeResourceUrl>();
  private musicPlayerPointerId: number | null = null;
  private musicDragOffsetX = 0;
  private musicDragOffsetY = 0;
  musicPlayerX = 0;
  musicPlayerY = 0;

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
    this.clearSoundtrackSelection();
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
        this.selectedUploads.map((entry) => ({
          ...entry.upload,
          soundtrackTitle: entry.soundtrackTitle,
          soundtrackLinkUrl: entry.soundtrackLinkUrl
        })),
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

  openMusicEditor(photo: GalleryPhoto): void {
    if (!this.isOwner()) {
      return;
    }

    this.editingMusicPhotoId.set(photo.id);
    this.editMusicTitle = this.getSoundtrackTitle(photo);
    this.editMusicLink = photo.soundtrackLinkUrl?.trim() || this.getDefaultSoundtrackUrl(photo);
  }

  closeMusicEditor(): void {
    this.editingMusicPhotoId.set(null);
  }

  async saveMusicEditor(): Promise<void> {
    const photoId = this.editingMusicPhotoId();
    const photo = photoId ? this.photos().find((item) => item.id === photoId) ?? null : null;

    if (!photo) {
      this.feedback.set({
        text: 'Choose a photo first.',
        tone: 'error'
      });
      return;
    }

    const updated = await this.vault.updatePhotoMusic(photo.id, this.editMusicTitle, this.editMusicLink);

    if (!updated) {
      this.feedback.set({
        text: this.vault.errorMessage() || 'I could not update the music.',
        tone: 'error'
      });
      return;
    }

    this.closeMusicEditor();
    this.feedback.set({
      text: 'Music updated for that memory.',
      tone: 'success'
    });
  }

  resetPickerValue(event: Event): void {
    const input = event.target as HTMLInputElement | null;

    if (input) {
      input.value = '';
    }
  }

  openPhoto(id: string): void {
    if (!this.photos().some((photo) => photo.id === id)) {
      return;
    }

    this.selectedPhotoId.set(id);
    this.resetMusicPlayerPosition();
    this.previousBodyOverflow = document.body.style.overflow;
    this.previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }

  closePhoto(): void {
    if (this.selectedPhotoId() === null && this.previousBodyOverflow === null) {
      return;
    }

    this.stopMusicDrag();
    this.selectedPhotoId.set(null);

    if (this.previousBodyOverflow !== null) {
      document.body.style.overflow = this.previousBodyOverflow;
      document.documentElement.style.overflow = this.previousHtmlOverflow || '';
      this.previousBodyOverflow = null;
      this.previousHtmlOverflow = null;
    }
  }

  trackByPhotoId(_index: number, photo: GalleryPhoto): string {
    return photo.id;
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
    const soundtrackTitle = this.getDefaultSoundtrackTitle(previewId);
    const soundtrackLinkUrl = '';

    if (this.looksLikeHeic(file)) {
      const prepared = await normalizePhotoBlob(file, file.name, { optimize: false });

      return {
        fileName: prepared.fileName,
        id: previewId,
        previewSrc: URL.createObjectURL(prepared.blob),
        upload: {
          blob: file,
          fileName: file.name,
          soundtrackTitle,
          soundtrackLinkUrl
        },
        wasHeicConverted: prepared.wasHeicConverted,
        soundtrackTitle,
        soundtrackLinkUrl
      };
    }

    return {
      fileName: file.name,
      id: previewId,
      previewSrc: URL.createObjectURL(file),
      upload: {
        blob: file,
        fileName: file.name,
        soundtrackTitle,
        soundtrackLinkUrl
      },
      wasHeicConverted: false,
      soundtrackTitle,
      soundtrackLinkUrl
    };
  }

  private looksLikeHeic(file: File): boolean {
    return /(\.heic|\.heif)$/i.test(file.name) || /image\/hei(c|f)/i.test(file.type);
  }

  onSoundtrackTitleChange(title: string): void {
    this.soundtrackTitle = title;
  }

  onSoundtrackLinkChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.soundtrackLink = input?.value.trim() ?? '';
  }

  private clearSoundtrackSelection(): void {
    this.soundtrackTitle = this.soundtrackOptions[0].title;
    this.soundtrackLink = '';
    this.editMusicTitle = this.soundtrackOptions[0].title;
    this.editMusicLink = '';
  }

  getSoundtrackTitle(photo: GalleryPhoto): string {
    if (photo.soundtrackTitle?.trim()) {
      return photo.soundtrackTitle.trim();
    }

    const index = this.getSoundtrackIndex(photo.id);
    return this.soundtrackOptions[index].title;
  }

  getSoundtrackUrl(photo: GalleryPhoto): string {
    return photo.soundtrackLinkUrl?.trim() || this.getDefaultSoundtrackUrl(photo);
  }

  isAudioLink(source: string): boolean {
    return /\.(mp3|m4a|aac|wav|ogg|flac)(\?|#|$)/i.test(source);
  }

  isYouTubeLink(source: string): boolean {
    return !!this.extractYouTubeVideoId(source);
  }

  getYouTubeEmbedUrl(source: string): SafeResourceUrl | null {
    const videoId = this.extractYouTubeVideoId(source);

    if (!videoId) {
      return null;
    }

    const cachedUrl = this.youtubeEmbedUrlCache.get(videoId);
    if (cachedUrl) {
      return cachedUrl;
    }

    const safeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&loop=1&playlist=${videoId}&rel=0&modestbranding=1&playsinline=1&controls=0&iv_load_policy=3&fs=0&disablekb=1`
    );
    this.youtubeEmbedUrlCache.set(videoId, safeUrl);
    return safeUrl;
  }

  private getDefaultSoundtrackTitle(seed: string): string {
    const index = this.getSoundtrackIndex(seed);
    return this.soundtrackOptions[index].title;
  }

  private getDefaultSoundtrackUrl(photo: GalleryPhoto): string {
    const index = this.getSoundtrackIndex(photo.id);
    return this.soundtrackOptions[index].url;
  }

  private getSoundtrackIndex(seed: string): number {
    const hashCode = seed.split('').reduce((acc, char) => {
      return ((acc << 5) - acc) + char.charCodeAt(0);
    }, 0);

    return Math.abs(hashCode) % this.soundtrackOptions.length;
  }

  private extractYouTubeVideoId(source: string): string | null {
    const trimmed = source.trim();

    if (!trimmed) {
      return null;
    }

    try {
      const parsedUrl = new URL(trimmed);
      const host = parsedUrl.hostname.replace(/^www\./i, '');

      if (host === 'youtu.be') {
        const id = parsedUrl.pathname.split('/').filter(Boolean)[0];
        return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }

      if (host.endsWith('youtube.com')) {
        const embedId = parsedUrl.pathname.match(/\/embed\/([A-Za-z0-9_-]{11})/i)?.[1];
        if (embedId) {
          return embedId;
        }

        const watchId = parsedUrl.searchParams.get('v');
        return watchId && /^[A-Za-z0-9_-]{11}$/.test(watchId) ? watchId : null;
      }
    } catch {
      return null;
    }

    return null;
  }

  startMusicDrag(event: PointerEvent, rail: HTMLElement): void {
    event.preventDefault();
    event.stopPropagation();

    this.musicPlayerDragging.set(true);
    this.musicPlayerPointerId = event.pointerId;

    const handle = event.currentTarget as HTMLElement | null;
    handle?.setPointerCapture(event.pointerId);

    const rect = rail.getBoundingClientRect();
    this.musicDragOffsetX = event.clientX - this.musicPlayerX;
    this.musicDragOffsetY = event.clientY - this.musicPlayerY;

    if (!rect.width || !rect.height) {
      this.musicPlayerX = event.clientX;
      this.musicPlayerY = event.clientY;
      return;
    }

    this.musicPlayerX = this.clampMusicPlayerCoordinate(
      event.clientX - this.musicDragOffsetX,
      rect.width / 2,
      window.innerWidth
    );
    this.musicPlayerY = this.clampMusicPlayerCoordinate(
      event.clientY - this.musicDragOffsetY,
      rect.height / 2,
      window.innerHeight
    );
  }

  @HostListener('window:pointermove', ['$event'])
  onWindowPointerMove(event: PointerEvent): void {
    if (!this.musicPlayerDragging() || this.musicPlayerPointerId !== event.pointerId) {
      return;
    }

    const rail = document.querySelector<HTMLElement>('.music-rail-modal');
    const rect = rail?.getBoundingClientRect();
    const halfWidth = rect?.width ? rect.width / 2 : 280;
    const halfHeight = rect?.height ? rect.height / 2 : 160;

    this.musicPlayerX = this.clampMusicPlayerCoordinate(
      event.clientX - this.musicDragOffsetX,
      halfWidth,
      window.innerWidth
    );
    this.musicPlayerY = this.clampMusicPlayerCoordinate(
      event.clientY - this.musicDragOffsetY,
      halfHeight,
      window.innerHeight
    );
  }

  @HostListener('window:pointerup', ['$event'])
  @HostListener('window:pointercancel', ['$event'])
  onWindowPointerEnd(event: PointerEvent): void {
    if (this.musicPlayerPointerId !== event.pointerId) {
      return;
    }

    this.stopMusicDrag();
  }

  private clearSelectedUploads(): void {
    for (const upload of this.selectedUploads) {
      if (upload.previewSrc) {
        URL.revokeObjectURL(upload.previewSrc);
      }
    }

    this.selectedUploads = [];
  }

  private clearYoutubeCache(): void {
    this.youtubeEmbedUrlCache.clear();
  }

  private stopMusicDrag(): void {
    this.musicPlayerDragging.set(false);
    this.musicPlayerPointerId = null;
  }

  private resetMusicPlayerPosition(): void {
    this.musicPlayerDragging.set(false);
    this.musicPlayerPointerId = null;
    this.musicPlayerX = Math.round(window.innerWidth / 2);
    this.musicPlayerY = Math.round(window.innerHeight * 0.82);
  }

  private clampMusicPlayerCoordinate(value: number, halfSize: number, viewportSize: number): number {
    const margin = 16;
    const min = halfSize + margin;
    const max = Math.max(min, viewportSize - halfSize - margin);
    return Math.min(Math.max(value, min), max);
  }

  isMobile(): boolean {
    return window.innerWidth <= 680;
  }

  get photoSources(): string[] {
    return this.photos().map((p) => p.src);
  }
}
