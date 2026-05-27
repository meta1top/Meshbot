import type { SuggestionsResponse } from "@meshbot/types-agent";
import { Controller, Get } from "@nestjs/common";
import { SuggestionService } from "../services/suggestion.service";

/** 首页"下一步行动建议"。 */
@Controller("api/suggestions")
export class SuggestionController {
  constructor(private readonly suggestions: SuggestionService) {}

  @Get()
  async getSuggestions(): Promise<SuggestionsResponse> {
    const suggestions = await this.suggestions.getSuggestions();
    return { suggestions };
  }
}
