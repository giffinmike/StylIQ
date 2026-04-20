import { IsString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class TripItemDto {
  @IsString()
  wardrobeItemId: string;

  @IsOptional()
  @IsString()
  role?: string;
}

export class CreateTripDto {
  @IsString()
  destination: string;

  @IsString()
  startDate: string;

  @IsString()
  endDate: string;

  @IsOptional()
  activities?: any;

  @IsOptional()
  @IsString()
  presentation?: string;

  @IsOptional()
  weather?: any;

  @IsOptional()
  capsule?: any;

  @IsOptional()
  @IsString()
  startingLocationId?: string;

  @IsOptional()
  @IsString()
  startingLocationLabel?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TripItemDto)
  items: TripItemDto[];
}
