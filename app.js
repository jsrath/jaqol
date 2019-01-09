const width = 1145;
const height = 641;

const projection = d3
  .geoAlbersUsa()
  .translate([width / 2, height / 2])
  .scale(1425);

const path = d3.geoPath().projection(projection);

const div = d3
  .select('body')
  .append('div')
  .attr('class', 'tooltip')
  .style('opacity', 0);

const svg = d3
  .select('#map')
  .append('svg')
  .attr('width', width)
  .attr('height', height)
  .attr('viewBox', `0 0 ${width} ${height}`)
  .attr('preserveAspectRatio', 'xMidYMid meet');

d3.json('us-states.json', states => {
  svg
    .selectAll('path')
    .data(states.features)
    .enter()
    .append('path')
    .attr('d', path)
    .attr('class', 'states');

  d3.json(
    '\x68\x74\x74\x70\x73\x3A\x2F\x2F\x6A\x73\x6F\x6E\x73\x68\x65\x65\x74\x73\x2E\x68\x65\x72\x6F\x6B\x75\x61\x70\x70\x2E\x63\x6F\x6D\x2F\x61\x70\x69\x3F\x69\x64\x3D\x31\x67\x43\x4F\x4A\x4D\x6A\x69\x2D\x2D\x36\x39\x69\x68\x70\x35\x52\x58\x6E\x45\x63\x45\x49\x42\x4F\x59\x4F\x50\x71\x37\x68\x32\x6B\x4E\x71\x72\x44\x4F\x6A\x6D\x31\x36\x58\x51\x26\x73\x68\x65\x65\x74\x3D\x32',
    data => {
      const jobNumbers = data.data.map(city => city.jobs);
      const circleScale = d3
        .scalePow()
        .exponent(0.5)
        .domain([0, d3.max(jobNumbers)])
        .range([0, 30]);
      const color = d3
        .scaleLinear()
        .domain([d3.min(jobNumbers), d3.mean(jobNumbers), d3.max(jobNumbers)])
        .range(['red', 'yellow', 'green']);

      svg
        .selectAll('.shapes')
        .data(data.data)
        .enter()
        .append(() => document.createElementNS('http://www.w3.org/2000/svg', 'circle'))
        .attr('class', 'shapes');

      svg
        .selectAll('circle')
        .attr('class', 'circle')
        .attr('cx', d => projection([d.lon, d.lat])[0])
        .attr('cy', d => projection([d.lon, d.lat])[1])
        .attr('r', d => circleScale(d.jobs))
        .attr('fill', d => color(d.jobs))
        .on('mouseover', (d, index, element) => {
          div
            .transition()
            .duration(200)
            .style('opacity', 0.9);

          div
            .html(`<p id="city">${d.city}</p> <p>${d.jobs}</p>`)
            .style('left', d3.event.pageX + 'px')
            .style('top', d3.event.pageY - 28 + 'px')
            .style('color', d3.select(element[index]).attr('fill'));
        })
        .on('mouseout', () => {
          div
            .transition()
            .duration(100)
            .style('opacity', 0);
        });
      d3.select('.loader').remove();
    },
  );
});
