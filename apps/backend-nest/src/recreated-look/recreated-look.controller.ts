import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { RecreatedLookService } from './recreated-look.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

async function retry<T>(fn: () => Promise<T>, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((res) => setTimeout(res, 150));
    }
  }
  throw lastError;
}

@UseGuards(JwtAuthGuard)
@Controller('users/:userId/recreated-looks')
export class RecreatedLookController {
  constructor(private readonly recreatedLookService: RecreatedLookService) {}

  @Post()
  async saveRecreatedLook(
    @Req() req,
    @Param('userId') paramUserId: string,
    @Body()
    body: {
      source_image_url: string;
      generated_outfit: any;
      tags?: string[];
    },
  ) {
    const userId = req.user.userId;

    if (paramUserId !== userId) {
      return { success: false, reason: 'user_mismatch' };
    }

    try {
      const result = await this.recreatedLookService.saveRecreatedLook(
        userId,
        body,
      );

      return { success: true, data: result };
    } catch (err) {
      console.error('[saveRecreatedLook] error:', err);

      // NEVER throw here
      return { success: false, reason: 'save_error' };
    }
  }

  @Get()
  async getRecentRecreatedLooks(@Req() req, @Query('limit') limit = '20') {
    const userId = req.user.userId;
    return this.recreatedLookService.getRecentRecreatedLooks(
      userId,
      parseInt(limit, 10),
    );
  }

  @Patch(':lookId')
  async updateRecreatedLook(
    @Req() req,
    @Param('lookId') lookId: string,
    @Body() body: { name?: string },
  ) {
    const userId = req.user.userId;
    return this.recreatedLookService.updateRecreatedLook(
      userId,
      lookId,
      body.name,
    );
  }

  @Delete(':lookId')
  async deleteRecreatedLook(@Req() req, @Param('lookId') lookId: string) {
    const userId = req.user.userId;
    return this.recreatedLookService.deleteRecreatedLook(userId, lookId);
  }
}
