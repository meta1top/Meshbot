import path from "node:path";
import { Module } from "@nestjs/common";
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  QueryResolver,
} from "nestjs-i18n";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: "zh",
      loader: I18nJsonLoader,
      loaderOptions: {
        path: path.join(__dirname, "i18n"),
        watch: process.env.NODE_ENV !== "production",
      },
      resolvers: [
        new CookieResolver(["locale"]),
        new HeaderResolver(["x-lang"]),
        new AcceptLanguageResolver(),
        new QueryResolver(["lang"]),
      ],
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
