import { Request, Response } from 'express';
import { Collection } from 'mongodb';
import { extractQueryStringParams, printPipeline } from './util';

export async function handler(
  req: Request,
  res: Response,
  entriesDB: Collection,
): Promise<void> {
  // extract and validate query string parameters
  const defaultSortColumn = 'total'
  const [params, err] = extractQueryStringParams(req, defaultSortColumn)

  // return 'Bad Request' if query string param was invalid
  if (err !== null) {
    res.status(400).json({ error: err.message })
    return;
  }

  // extract params
  const {identifier, skip, limit, sortBy, sortDir} = params

  // define the aggregation pipeline
  let pipeline: object[] = [
    { $match: { root: { $exists: true, $ne: "" } } },
    { $sort: { type : -1 }}, // NEWCONTENT > INTERACTION (used for $first meta)
    {
      $addFields: {
        last24H: {
          $cond: [{ $gte: ['$createdAt', new Date(new Date().setDate(new Date().getDate() - 1))] }, true, false]
        },
      }
    },
    {
      $group: {
        _id: '$root',
        skapp: { $first: '$skapp' },
        metadata: { $first: '$metadata.skylinkMetadata' },
        link: { $first: '$metadata.content.link' },
        total: { $sum: 1 },
        last24H: { $sum: { $cond: ['$last24H', 1, 0] } },

        // these fields will be used to set "creator"
        type: { $first: '$type' },
        user: { $first: '$userPK' },
      }
    },
    {
      $addFields: {
        creator: {
          $cond: [
            { $eq: ['$type', 'newcontent'] },
            '$user',
            'unknown'
          ]
        },
      }
    },
    { $sort:  { [sortBy]: sortDir === 'asc' ? 1 : -1, _id: -1 }},
    {
      $group: {
        _id: null,
        rows: {
          $push: {
            identifier: '$_id',
            creator: '$creator',
            skapp: '$skapp',
            metadata: '$metadata',
            link: '$link',
            total: { $toInt: '$total' },
            last24H: { $toInt: '$last24H' },
          }
        }
      }
    },
    {
      $unwind: {
        path: "$rows",
        includeArrayIndex: "rank"
      }
    },
    {
      $replaceRoot: {
        newRoot: {
          identifier: "$rows.identifier",
          creator: "$rows.creator",
          skapp: "$rows.skapp",
          metadata: '$rows.metadata',
          link: "$rows.link",
          total: "$rows.total",
          last24H: "$rows.last24H",
          rank: { $toInt: { $sum: ['$rank', 1] } }
        }
      }
    },
  ];

  // filter on identifier if necessary
  if (identifier) {
    pipeline = [
      ...pipeline,
      { $match: { identifier: {$regex: identifier } } },
    ]
  }

  pipeline = [
    ...pipeline,
    { $skip: skip },
    { $limit: limit },
  ]

  printPipeline(pipeline) // will only print if flag is set
  
  const contentCatalogCursor = entriesDB.aggregate(pipeline)
  const contentCatalog = await contentCatalogCursor.toArray()

  res.set("Connection", "close")
  res.status(200).json(contentCatalog);
}
