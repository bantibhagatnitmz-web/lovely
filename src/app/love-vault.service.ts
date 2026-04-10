import { Injectable, signal } from '@angular/core';
import { Session, SupabaseClient, createClient } from '@supabase/supabase-js';
import { cloudGalleryConfig, hasCloudGalleryConfig } from './cloud-gallery.config';
import { looksLikeImageFile, normalizePhotoBlob } from './photo-normalizer';

export type AccessRole = 'owner' | 'viewer';

export interface AuthViewer {
  email: string;
}

export interface GalleryPhoto {
  id: string;
  fileName: string;
  caption: string;
  addedAt: string;
  src: string;
  storagePath: string;
  soundtrackTitle: string;
  soundtrackLinkUrl: string;
}

export interface UploadPhotoInput {
  blob: Blob;
  fileName: string;
  soundtrackTitle?: string;
  soundtrackLinkUrl?: string;
}

interface GalleryMemberRow {
  email: string;
  role: AccessRole;
}

interface GalleryPhotoRow {
  id: string;
  file_name: string;
  caption: string | null;
  created_at: string;
  storage_path: string;
  soundtrack_title: string | null;
  soundtrack_link_url: string | null;
}

type AppGlobal = typeof globalThis & {
  __ankitaGallerySupabaseClient?: SupabaseClient;
};

const authLockQueue = new Map<string, Promise<void>>();

async function withInMemoryAuthLock<R>(
  name: string,
  _acquireTimeout: number,
  fn: () => Promise<R>
): Promise<R> {
  const previous = authLockQueue.get(name) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);

  authLockQueue.set(name, tail);
  await previous.catch(() => undefined);

  try {
    return await fn();
  } finally {
    releaseCurrent();

    if (authLockQueue.get(name) === tail) {
      authLockQueue.delete(name);
    }
  }
}

function getSupabaseClient(): SupabaseClient {
  const appGlobal = globalThis as AppGlobal;

  if (!appGlobal.__ankitaGallerySupabaseClient) {
    appGlobal.__ankitaGallerySupabaseClient = createClient(
      cloudGalleryConfig.supabaseUrl,
      cloudGalleryConfig.supabaseAnonKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          lock: withInMemoryAuthLock
        }
      }
    );
  }

  return appGlobal.__ankitaGallerySupabaseClient;
}

@Injectable({ providedIn: 'root' })
export class LoveVaultService {
  readonly busy = signal(false);
  readonly ready = signal(false);
  readonly configured = signal(hasCloudGalleryConfig());
  readonly errorMessage = signal('');
  readonly currentUser = signal<AuthViewer | null>(null);
  readonly currentRole = signal<AccessRole | null>(null);
  readonly photos = signal<GalleryPhoto[]>([]);
  private sessionSync = Promise.resolve();

  private readonly supabase: SupabaseClient | null = this.configured()
    ? getSupabaseClient()
    : null;

  constructor() {
    void this.initialize();
  }

  async initialize(): Promise<void> {
    if (!this.supabase) {
      this.ready.set(true);
      return;
    }

    this.supabase.auth.onAuthStateChange((_event, session) => {
      queueMicrotask(() => {
        void this.queueSessionSync(session);
      });
    });

    const {
      data: { session }
    } = await this.supabase.auth.getSession();

    await this.queueSessionSync(session);
    this.ready.set(true);
  }

  async signIn(email: string, password: string): Promise<boolean> {
    if (!this.supabase) {
      this.errorMessage.set('Supabase is not configured yet.');
      return false;
    }

    this.busy.set(true);
    this.errorMessage.set('');

    try {
      const { data, error } = await this.supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password
      });

      if (error) {
        this.errorMessage.set(this.formatAuthError(error.message));
        return false;
      }

      await this.queueSessionSync(data.session ?? null);
      return true;
    } finally {
      this.busy.set(false);
    }
  }

  async signUp(
    email: string,
    password: string
  ): Promise<{ success: boolean; requiresEmailConfirmation: boolean }> {
    if (!this.supabase) {
      this.errorMessage.set('Supabase is not configured yet.');
      return { success: false, requiresEmailConfirmation: false };
    }

    this.busy.set(true);
    this.errorMessage.set('');

    try {
      const { data, error } = await this.supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: this.getEmailRedirectUrl()
        }
      });

      if (error) {
        this.errorMessage.set(this.formatAuthError(error.message));
        return { success: false, requiresEmailConfirmation: false };
      }

      if (data.session) {
        await this.queueSessionSync(data.session);
      }

      return {
        success: true,
        requiresEmailConfirmation: !data.session
      };
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<void> {
    if (!this.supabase) {
      return;
    }

    await this.supabase.auth.signOut();
    this.currentUser.set(null);
    this.currentRole.set(null);
    this.photos.set([]);
    this.errorMessage.set('');
  }

  async saveFiles(files: UploadPhotoInput[], caption: string): Promise<boolean> {
    if (!this.supabase || this.currentRole() !== 'owner') {
      this.errorMessage.set('Only the owner account can upload photos.');
      return false;
    }

    const imageFiles = files.filter((file) => this.looksLikeImage(file.fileName, file.blob.type));

    if (!imageFiles.length) {
      this.errorMessage.set('Choose at least one valid image file.');
      return false;
    }

    this.busy.set(true);
    this.errorMessage.set('');
    const supabase = this.supabase;

    try {
      const rows = await Promise.all(
        imageFiles.map(async (file) => {
        const soundtrackTitle = file.soundtrackTitle?.trim() || '';
        const soundtrackLinkUrl = file.soundtrackLinkUrl?.trim() || '';
        const normalizedFile = await normalizePhotoBlob(file.blob, file.fileName);
        const extension = this.getFileExtension(normalizedFile.fileName, normalizedFile.blob.type);
        const storagePath = `photos/${crypto.randomUUID()}.${extension}`;

        const { error: uploadError } = await supabase.storage
          .from(cloudGalleryConfig.bucketName)
          .upload(storagePath, normalizedFile.blob, {
            contentType: normalizedFile.blob.type || 'image/jpeg',
            upsert: false
          });

        if (uploadError) {
          throw uploadError;
        }

        return {
          caption: caption.trim(),
          created_at: new Date().toISOString(),
          file_name: normalizedFile.fileName,
          id: crypto.randomUUID(),
          storage_path: storagePath,
          soundtrack_title: soundtrackTitle,
          soundtrack_link_url: soundtrackLinkUrl || null
        };
        })
      );

      const { error: insertError } = await supabase.from('gallery_photos').insert(rows);

      if (insertError) {
        throw insertError;
      }

      await this.loadPhotos();
      return true;
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Upload failed.';
      this.errorMessage.set(this.formatAuthError(details));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async removePhoto(photo: GalleryPhoto): Promise<boolean> {
    if (!this.supabase || this.currentRole() !== 'owner') {
      this.errorMessage.set('Only the owner account can delete photos.');
      return false;
    }

    this.busy.set(true);
    this.errorMessage.set('');

    try {
      const { error: storageError } = await this.supabase.storage
        .from(cloudGalleryConfig.bucketName)
        .remove([photo.storagePath]);

      if (storageError) {
        throw storageError;
      }

      const { error: deleteError } = await this.supabase
        .from('gallery_photos')
        .delete()
        .eq('id', photo.id);

      if (deleteError) {
        throw deleteError;
      }

      await this.loadPhotos();
      return true;
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Delete failed.';
      this.errorMessage.set(this.formatAuthError(details));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async updatePhotoMusic(photoId: string, soundtrackTitle: string, soundtrackLinkUrl: string): Promise<boolean> {
    if (!this.supabase || this.currentRole() !== 'owner') {
      this.errorMessage.set('Only the owner account can edit photo music.');
      return false;
    }

    this.busy.set(true);
    this.errorMessage.set('');

    try {
      const { error: updateError } = await this.supabase
        .from('gallery_photos')
        .update({
          soundtrack_title: soundtrackTitle.trim(),
          soundtrack_link_url: soundtrackLinkUrl.trim() || null
        })
        .eq('id', photoId);

      if (updateError) {
        throw updateError;
      }

      await this.loadPhotos();
      return true;
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Music update failed.';
      this.errorMessage.set(this.formatAuthError(details));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private queueSessionSync(session: Session | null): Promise<void> {
    this.sessionSync = this.sessionSync
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.handleSession(session);
        } catch (error) {
          const details = error instanceof Error ? error.message : 'Could not sync the gallery session.';
          this.errorMessage.set(this.formatAuthError(details));
        }
      });

    return this.sessionSync;
  }

  private async handleSession(session: Session | null): Promise<void> {
    if (!this.supabase || !session?.user?.email) {
      this.currentUser.set(null);
      this.currentRole.set(null);
      this.photos.set([]);
      return;
    }

    const email = session.user.email.toLowerCase();
    const role = await this.fetchCurrentRole(email);

    if (!role) {
      this.errorMessage.set('This account does not have access to the gallery.');
      await this.supabase.auth.signOut();
      this.currentUser.set(null);
      this.currentRole.set(null);
      this.photos.set([]);
      return;
    }

    this.currentUser.set({ email });
    this.currentRole.set(role);
    this.errorMessage.set('');
    await this.loadPhotos();
  }

  private async fetchCurrentRole(email: string): Promise<AccessRole | null> {
    if (!this.supabase) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('gallery_members')
      .select('email, role')
      .eq('email', email)
      .maybeSingle<GalleryMemberRow>();

    if (error || !data?.role) {
      return null;
    }

    return data.role;
  }

  private async loadPhotos(): Promise<void> {
    if (!this.supabase || !this.currentUser()) {
      this.photos.set([]);
      return;
    }

    const { data, error } = await this.loadPhotoRows();

    if (error) {
      this.errorMessage.set(error.message);
      this.photos.set([]);
      return;
    }

    const photos = await Promise.all(
      (data ?? []).map(async (row) => ({
        addedAt: row.created_at,
        caption: row.caption ?? '',
        fileName: row.file_name,
        id: row.id,
        src: await this.createSignedUrl(row.storage_path),
        storagePath: row.storage_path,
        soundtrackTitle: row.soundtrack_title ?? '',
        soundtrackLinkUrl: row.soundtrack_link_url ?? ''
      }))
    );

    this.photos.set(photos.filter((photo) => !!photo.src));
  }

  private async loadPhotoRows(): Promise<{ data: GalleryPhotoRow[] | null; error: { message: string } | null }> {
    if (!this.supabase) {
      return { data: null, error: null };
    }

    const richQuery = await this.supabase
      .from('gallery_photos')
      .select('id, file_name, caption, created_at, storage_path, soundtrack_title, soundtrack_link_url')
      .order('created_at', { ascending: false })
      .returns<GalleryPhotoRow[]>();

    if (!richQuery.error) {
      return richQuery;
    }

    if (!this.looksLikeMissingMusicColumnError(richQuery.error.message)) {
      return richQuery;
    }

    const legacyQuery = await this.supabase
      .from('gallery_photos')
      .select('id, file_name, caption, created_at, storage_path')
      .order('created_at', { ascending: false })
      .returns<GalleryPhotoRow[]>();

    if (legacyQuery.data) {
      return {
        data: legacyQuery.data.map((row) => ({
          ...row,
          soundtrack_title: '',
          soundtrack_link_url: null
        })),
        error: legacyQuery.error
      };
    }

    return legacyQuery;
  }

  private async createSignedUrl(storagePath: string): Promise<string> {
    if (!this.supabase) {
      return '';
    }

    const { data, error } = await this.supabase.storage
      .from(cloudGalleryConfig.bucketName)
      .createSignedUrl(storagePath, 60 * 60);

    if (error) {
      return '';
    }

    const signedUrl = (data as { signedUrl?: string; signedURL?: string } | null)?.signedUrl
      ?? (data as { signedUrl?: string; signedURL?: string } | null)?.signedURL
      ?? '';

    return signedUrl;
  }

  private looksLikeImage(fileName: string, mimeType: string): boolean {
    return looksLikeImageFile(fileName, mimeType);
  }

  private looksLikeMissingMusicColumnError(message: string): boolean {
    return /soundtrack_title|soundtrack_link_url|column .*does not exist/i.test(message);
  }

  private getFileExtension(fileName: string, mimeType: string): string {
    const fileExtension = fileName.split('.').pop()?.toLowerCase();

    if (fileExtension) {
      return fileExtension;
    }

    const mimeExtension = mimeType.split('/').pop()?.toLowerCase();
    return mimeExtension || 'jpg';
  }

  private formatAuthError(message: string): string {
    if (/email rate limit exceeded/i.test(message)) {
      return 'Supabase blocked more signup emails for now. Wait a while, or temporarily turn off Confirm email in Supabase under Authentication > Providers > Email, then try signup once.';
    }

    return message;
  }

  private getEmailRedirectUrl(): string | undefined {
    if (typeof window === 'undefined') {
      return undefined;
    }

    return window.location.origin;
  }
}
