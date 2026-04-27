import { Injectable } from '@nestjs/common';
import { WardrobeService } from '../wardrobe.service';
import { studioAuditLog } from './audit';

// AI Outfit Studio Facade
// ─────────────────────────────────────────────────────────────────────────────
// The single entry point used by WardrobeController for the Studio handlers
// (POST /api/wardrobe/outfits and POST /api/wardrobe/outfits/fast).
//
// Day 1 behavior: every method delegates 1:1 to the existing WardrobeService
// method. No quality, scoring, prompt, or filter changes. Future Studio-only
// changes happen INSIDE this namespace; shared modules remain byte-identical.
//
// Argument and return types are forwarded from WardrobeService via
// Parameters<>/ReturnType<> so signatures cannot drift from the underlying
// service.

type GenerateOutfitsArgs = Parameters<WardrobeService['generateOutfits']>;
type GenerateOutfitsRet = ReturnType<WardrobeService['generateOutfits']>;

type GenerateOutfitsFastArgs = Parameters<WardrobeService['generateOutfitsFast']>;
type GenerateOutfitsFastRet = ReturnType<WardrobeService['generateOutfitsFast']>;

type RecomposeOutfitSlotArgs = Parameters<WardrobeService['recomposeOutfitSlot']>;
type RecomposeOutfitSlotRet = ReturnType<WardrobeService['recomposeOutfitSlot']>;

type MutateOutfitArgs = Parameters<WardrobeService['mutateOutfit']>;
type MutateOutfitRet = ReturnType<WardrobeService['mutateOutfit']>;

@Injectable()
export class AiOutfitStudioFacade {
  constructor(private readonly service: WardrobeService) {}

  generateOutfits(...args: GenerateOutfitsArgs): GenerateOutfitsRet {
    studioAuditLog('facade.generateOutfits', {
      sharedTarget: 'WardrobeService.generateOutfits',
    });
    return this.service.generateOutfits(...args);
  }

  generateOutfitsFast(
    ...args: GenerateOutfitsFastArgs
  ): GenerateOutfitsFastRet {
    studioAuditLog('facade.generateOutfitsFast', {
      sharedTarget: 'WardrobeService.generateOutfitsFast',
    });
    return this.service.generateOutfitsFast(...args);
  }

  recomposeOutfitSlot(
    ...args: RecomposeOutfitSlotArgs
  ): RecomposeOutfitSlotRet {
    studioAuditLog('facade.recomposeOutfitSlot', {
      sharedTarget: 'WardrobeService.recomposeOutfitSlot',
    });
    return this.service.recomposeOutfitSlot(...args);
  }

  mutateOutfit(...args: MutateOutfitArgs): MutateOutfitRet {
    studioAuditLog('facade.mutateOutfit', {
      sharedTarget: 'WardrobeService.mutateOutfit',
    });
    return this.service.mutateOutfit(...args);
  }
}
