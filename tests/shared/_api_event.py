"""WHIT-825: the one fake API Gateway request every server test builds.

Keys are only emitted when their argument is passed, so a converted event stays
identical to the hand-written dict it replaced. `raw` is a pre-encoded body string
(bad JSON, base64, "") passed through untouched and wins over `body`.
"""

import json


def api_event(method, path, body=None, path_params=None, query=None, raw=None, is_base64=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if path_params is not None:
        event["pathParameters"] = path_params
    if query is not None:
        event["queryStringParameters"] = query
    if raw is not None:
        event["body"] = raw
    elif body is not None:
        event["body"] = json.dumps(body)
    if is_base64 is not None:
        event["isBase64Encoded"] = is_base64
    return event
