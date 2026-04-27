import { Module } from '@nestjs/common';
import { WardrobeController } from './wardrobe.controller';
import { WardrobePublicController } from './wardrobe.public.controller';
import { WardrobeService } from './wardrobe.service';
import { VertexModule } from '../vertex/vertex.module';
import { LearningModule } from '../learning/learning.module';
import { AiOutfitStudioFacade } from './aiOutfitStudio/aiOutfitStudio.facade';

@Module({
  imports: [VertexModule, LearningModule],
  controllers: [WardrobePublicController, WardrobeController],
  providers: [WardrobeService, AiOutfitStudioFacade],
  exports: [WardrobeService],
})
export class WardrobeModule {}
