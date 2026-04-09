// This module imports and exports FsLightbox for Angular 16-19 compatibility
import { NgModule } from '@angular/core';
import { FsLightbox } from 'fslightbox-angular/16-19';

@NgModule({
  imports: [FsLightbox],
  exports: [FsLightbox]
})
export class FsLightboxModule {}
