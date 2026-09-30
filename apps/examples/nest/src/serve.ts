import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.ts';

const port = Number(process.env['PORT'] ?? 3460);

const app = await NestFactory.create(AppModule);
await app.listen(port, '127.0.0.1');
