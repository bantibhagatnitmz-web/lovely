export const cloudGalleryConfig = {
  supabaseUrl: 'https://glajfmisqgsknkgtioqy.supabase.co',
  supabaseAnonKey: 'sb_publishable_etZ0qPJ9IaTobZYJe0vu6w_GmiM1e3l',
  bucketName: 'ankita-private-gallery'
};

export function hasCloudGalleryConfig(): boolean {
  return (
    !!cloudGalleryConfig.supabaseUrl &&
    !!cloudGalleryConfig.supabaseAnonKey &&
    !cloudGalleryConfig.supabaseUrl.includes('YOUR_PROJECT') &&
    !cloudGalleryConfig.supabaseAnonKey.includes('YOUR_SUPABASE_ANON_KEY')
  );
}
