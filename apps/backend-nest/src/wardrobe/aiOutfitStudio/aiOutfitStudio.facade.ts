import { Injectable } from '@nestjs/common';
import { WardrobeService } from '../wardrobe.service';
import { studioAuditLog } from './audit';
import { postProcessLegacyResult } from './postProcessLegacy';

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

  async generateOutfits(...args: GenerateOutfitsArgs): GenerateOutfitsRet {
    studioAuditLog('facade.generateOutfits', {
      sharedTarget: 'WardrobeService.generateOutfits',
    });
    const result = await this.service.generateOutfits(...args);

    // Controller call shape: (userId, query, topK, opts)
    const query = typeof args[1] === 'string' ? args[1] : undefined;
    const opts: any = args[3] ?? {};
    const processed = postProcessLegacyResult(result, {
      query,
      userStyle: opts.userStyle,
      weather: opts.weather,
    });

    if (process.env.AI_OUTFIT_STUDIO_DEBUG === '1') {
      const arr: any[] = Array.isArray((processed as any)?.outfits)
        ? (processed as any).outfits
        : [];
      const top3 = arr
        .slice(0, 3)
        .map((o: any) => String(o?.outfit_id ?? ''))
        .join(',');
      // eslint-disable-next-line no-console
      console.log(
        `[AI_OUTFIT_STUDIO_DEBUG] facade_return_count=${arr.length} top3=${top3}`,
      );
    }

    return processed;
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
