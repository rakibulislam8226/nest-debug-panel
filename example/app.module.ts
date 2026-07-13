import { Module } from '@nestjs/common';
import { DebugModule, FetchPlugin } from '../src';
import { DemoController } from './demo.controller';
import { FakeDatabaseService } from './fake-database.service';

@Module({
  imports: [
    DebugModule.forRoot({
      enabled: process.env.NODE_ENV !== 'production',
      maxRequests: 200,
      captureResponseBody: true,
      slowQueryThreshold: 100,
      slowRequestThreshold: 150,
      routePrefix: '/nest-debug-panel',
      ignore: ['/favicon.ico'],
      plugins: [
        new FetchPlugin(),
        // Real integrations (see README / docs/plugins.md):
        //   new PrismaPlugin()  + prismaPlugin.attach(client) + client.$extends(prismaPlugin.extension())
        //   new RedisPlugin()   + redisPlugin.attach(ioredisClient)
        //   new AxiosPlugin()   + axiosPlugin.attach(httpService.axiosRef)
      ],
    }),
  ],
  controllers: [DemoController],
  providers: [FakeDatabaseService],
})
export class AppModule {}
