import sys
import json
from tokenc import TokenClient

client = TokenClient(api_key="your-api-key")

if len(sys.argv) > 1 and sys.argv[1] == "--stdin":
    input_text = sys.stdin.read()
elif len(sys.argv) > 1:
    input_text = sys.argv[1]
else:
    input_text = sys.stdin.read()

response = client.compress_input(
    input=input_text,
    aggressiveness=0.5,
)

result = {
    "compressed": response.output,
    "tokens_saved": response.tokens_saved,
    "compression_ratio": response.compression_ratio,
}

print(json.dumps(result))
