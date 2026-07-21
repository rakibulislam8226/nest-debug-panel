import { Module } from '@nestjs/common';
import { DebugModule, FetchPlugin } from '../src';
import { DemoController } from './demo.controller';
import { DemoGateway } from './demo.gateway';
import { FakeDatabaseService } from './fake-database.service';

@Module({
  imports: [
    DebugModule.forRoot({
      enabled: process.env.NODE_ENV !== 'production',
      maxRequests: 200,
      captureResponseBody: true,
      slowQueryThreshold: 100,
      slowRequestThreshold: 150,
      routePrefix: '/__debug',
      ignore: ['/favicon.ico'],
      plugins: [
        new FetchPlugin(),
        // Real integrations (see README):
        //   new PrismaPlugin()  + prismaPlugin.attach(client) + client.$extends(prismaPlugin.extension())
        //   new RedisPlugin()   + redisPlugin.attach(ioredisClient)
        //   new AxiosPlugin()   + axiosPlugin.attach(httpService.axiosRef)
      ],
    }),
  ],
  controllers: [DemoController],
  providers: [FakeDatabaseService, DemoGateway],
})
export class AppModule {}
